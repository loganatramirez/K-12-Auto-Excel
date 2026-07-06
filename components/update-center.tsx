"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Search, X } from "lucide-react";
import {
  getModuleRows,
  getModuleTitle,
  moduleColumns,
  type ModuleKey,
  type WorkspaceRecord
} from "@/lib/data";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { WorkbookSidebar } from "./workbook-sidebar";

type SuggestionStatus = "pending" | "approved" | "rejected";
type ReviewStatusFilter = SuggestionStatus | "all";

type UpdateSuggestion = {
  id: string;
  module: ModuleKey;
  record_id: string;
  field_key: string;
  current_value: string | null;
  proposed_value: string;
  source_title: string | null;
  source_url: string | null;
  source_excerpt: string | null;
  confidence: number | null;
  status: SuggestionStatus;
  created_at: string | null;
};

type SourceCandidate = {
  category?: "board_materials" | "cdiac_debtwatch" | "emma_os_pos" | "issuer_site" | "supplemental" | "transaction_pages";
  reason: string;
  score: number;
  snippet: string;
  status: "excluded" | "kept" | "not_selected";
  title: string;
  url: string;
};

type InstitutionSourceCandidates = {
  institution: string;
  sources: SourceCandidate[];
};

type WorkflowGroup = {
  key: string;
  label: string;
  fields: string[];
  cadence: string;
  isAvailable: boolean;
};

const moduleTabs: Array<{ key: ModuleKey; label: string; description: string }> = [
  { key: "k12-targets", label: "K-12 Targets", description: "Districts" },
  { key: "ccd-targets", label: "CCD Targets", description: "Community colleges" },
  { key: "plans", label: "FY25&26", description: "Business plan" }
];

const workflowGroups: Record<ModuleKey, WorkflowGroup[]> = {
  "k12-targets": [
    {
      key: "deal-team",
      label: "Last Deal / MA / UW / BC",
      fields: ["Last Deal", "MA", "UW", "BC"],
      cadence:
        "Suggested manual cadence: monthly for active targets. Uses a query matrix first, then keeps a larger candidate pool before ranking sources. Newest deal wins: 2025/2026 sources are preferred, and 2023/2024 are fallback only. EMMA/OS/POS is the main path when reachable; if EMMA cannot be read directly, OS/POS PDFs, CDIAC/DebtWatch, agenda/minutes, staff reports, resolutions, transaction pages, BondLink, and MuniOS are ranked as supporting paths. Lower-confidence deal candidates enter review, but never auto-apply.",
      isAvailable: true
    },
    {
      key: "leadership",
      label: "Sup / CBO / Board",
      fields: ["Sup", "CBO", "Board 1", "Board 2", "Board 3", "Board 4", "Board 5", "Board 6", "Board 7"],
      cadence: "Suggested manual cadence: quarterly; run before pitches or meetings for selected institutions.",
      isAvailable: true
    },
    {
      key: "authorization",
      label: "Auth",
      fields: ["Auth"],
      cadence: "Suggested manual cadence: quarterly for selected institutions.",
      isAvailable: true
    }
  ],
  "ccd-targets": [
    {
      key: "ccd-finance",
      label: "Authorizations / Refundings / Deal Team",
      fields: ["Authorizations", "Refundings", "Underwriter", "MA", "BC"],
      cadence: "CCD automation is not wired yet. This tab is ready for CCD review once the scanner is added.",
      isAvailable: false
    },
    {
      key: "ccd-leadership",
      label: "Chancellor / CFO",
      fields: ["Chancellor", "CFO"],
      cadence: "Suggested manual cadence: quarterly; run before pitches or meetings for selected CCDs.",
      isAvailable: true
    }
  ],
  plans: [
    {
      key: "plan-fields",
      label: "Plan Fields",
      fields: [
        "MA",
        "Deal",
        "Role sale",
        "Date",
        "Par ($M)",
        "Fee",
        "Liab.",
        "EST Rev",
        "Prob.",
        "ADJ Rev",
        "Lead",
        "SRSupp.",
        "Supp."
      ],
      cadence: "FY25&26 automation is not wired yet. This tab is ready for future plan review suggestions.",
      isAvailable: false
    }
  ]
};

const reviewStatusFilters: Array<{ key: ReviewStatusFilter; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "all", label: "All" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" }
];

const maxResearchSelection = 100;

export function UpdateCenter() {
  const [activeModuleKey, setActiveModuleKey] = useState<ModuleKey>("k12-targets");
  const activeRows = useMemo(
    () => getModuleRows(activeModuleKey).filter((row): row is WorkspaceRecord => row.kind !== "section"),
    [activeModuleKey]
  );
  const allRows = useMemo(
    () => moduleTabs.flatMap((tab) => getModuleRows(tab.key).filter((row) => row.kind !== "section")),
    []
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [suggestions, setSuggestions] = useState<UpdateSuggestion[]>([]);
  const [status, setStatus] = useState(isSupabaseConfigured() ? "Loading" : "Needs setup");
  const [message, setMessage] = useState(
    isSupabaseConfigured() ? "Loading review queue." : "Connect Supabase to enable the review queue."
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isAutomationRunning, setIsAutomationRunning] = useState(false);
  const [activeWorkflowKey, setActiveWorkflowKey] = useState("deal-team");
  const [sourceCandidates, setSourceCandidates] = useState<InstitutionSourceCandidates[]>([]);
  const [institutionQuery, setInstitutionQuery] = useState("");
  const [reviewStatusFilter, setReviewStatusFilter] = useState<ReviewStatusFilter>("pending");
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>(() =>
    getModuleRows("k12-targets")
      .filter((row) => row.kind !== "section")
      .slice(0, maxResearchSelection)
      .map((row) => row.id)
  );

  const activeWorkflows = workflowGroups[activeModuleKey];
  const activeWorkflow = useMemo(
    () => activeWorkflows.find((workflow) => workflow.key === activeWorkflowKey) ?? activeWorkflows[0],
    [activeWorkflowKey, activeWorkflows]
  );
  const selectedRecordIdSet = useMemo(() => new Set(selectedRecordIds), [selectedRecordIds]);
  const rowTitleById = useMemo(() => new Map(allRows.map((row) => [row.id, row.title])), [allRows]);
  const filteredRows = useMemo(() => {
    const normalizedQuery = institutionQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return activeRows;
    }

    return activeRows.filter((row) =>
      [row.title, row.subtitle, recordMeta(row, activeModuleKey)]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery)
    );
  }, [activeModuleKey, activeRows, institutionQuery]);
  const moduleSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.module === activeModuleKey),
    [activeModuleKey, suggestions]
  );
  const activeSuggestions = useMemo(
    () =>
      moduleSuggestions.filter((suggestion) =>
        activeWorkflow.fields.some((field) => field === suggestion.field_key)
      ),
    [activeWorkflow.fields, moduleSuggestions]
  );
  const pendingCount = useMemo(
    () => moduleSuggestions.filter((suggestion) => suggestion.status === "pending").length,
    [moduleSuggestions]
  );
  const activePendingCount = useMemo(
    () => activeSuggestions.filter((suggestion) => suggestion.status === "pending").length,
    [activeSuggestions]
  );
  const visibleSuggestions = useMemo(() => {
    const fieldOrder = new Map<string, number>(activeWorkflow.fields.map((field, index) => [field, index]));

    return [...activeSuggestions]
      .filter((suggestion) => reviewStatusFilter === "all" || suggestion.status === reviewStatusFilter)
      .sort((left, right) => {
        const leftTitle = rowTitleById.get(left.record_id) ?? left.record_id;
        const rightTitle = rowTitleById.get(right.record_id) ?? right.record_id;
        const titleCompare = leftTitle.localeCompare(rightTitle);

        if (titleCompare !== 0) {
          return titleCompare;
        }

        return (fieldOrder.get(left.field_key) ?? 999) - (fieldOrder.get(right.field_key) ?? 999);
      });
  }, [activeSuggestions, activeWorkflow.fields, reviewStatusFilter, rowTitleById]);
  const groupedVisibleSuggestions = useMemo(() => {
    const groups = new Map<string, UpdateSuggestion[]>();

    visibleSuggestions.forEach((suggestion) => {
      const group = groups.get(suggestion.record_id) ?? [];
      group.push(suggestion);
      groups.set(suggestion.record_id, group);
    });

    return Array.from(groups.entries()).map(([recordId, groupSuggestions]) => ({
      recordId,
      suggestions: groupSuggestions,
      title: rowTitleById.get(recordId) ?? recordId
    }));
  }, [rowTitleById, visibleSuggestions]);
  const canRunResearch = activeWorkflow.isAvailable;
  const activeModuleTitle = getModuleTitle(activeModuleKey);
  const activeEntityLabel = entityLabel(activeModuleKey);

  useEffect(() => {
    const defaultWorkflow = workflowGroups[activeModuleKey][0];
    setActiveWorkflowKey(defaultWorkflow.key);
    setInstitutionQuery("");
    setSourceCandidates([]);
    setSelectedRecordIds(activeRows.slice(0, maxResearchSelection).map((row) => row.id));
    setReviewStatusFilter("pending");
  }, [activeModuleKey, activeRows]);

  async function loadSuggestions() {
    if (!isSupabaseConfigured()) {
      return;
    }

    const supabase = createSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    const { data, error } = await supabase
      .from("update_suggestions")
      .select(
        "id, module, record_id, field_key, current_value, proposed_value, source_title, source_url, source_excerpt, confidence, status, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      setStatus("Sync error");
      setMessage("Run lib/schema.sql in Supabase, then refresh this page.");
      return;
    }

    setSuggestions((data ?? []) as UpdateSuggestion[]);
    setStatus("Ready");
    setMessage("Review queue loaded.");
  }

  useEffect(() => {
    loadSuggestions();
  }, []);

  async function reviewSuggestion(suggestion: UpdateSuggestion, nextStatus: SuggestionStatus) {
    const supabase = createSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    setBusyId(suggestion.id);
    setStatus("Saving");
    setMessage("Saving review decision.");

    if (nextStatus === "approved") {
      const { error: upsertError } = await supabase.from("workbook_field_values").upsert(
        {
          module: suggestion.module,
          record_id: suggestion.record_id,
          field_key: suggestion.field_key,
          value: suggestion.proposed_value,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "record_id,field_key"
        }
      );

      if (upsertError) {
        setBusyId(null);
        setStatus("Sync error");
        setMessage(upsertError.message);
        return;
      }
    }

    const { error } = await supabase
      .from("update_suggestions")
      .update({
        status: nextStatus,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", suggestion.id);

    if (error) {
      setBusyId(null);
      setStatus("Sync error");
      setMessage(error.message);
      return;
    }

    setSuggestions((currentSuggestions) =>
      currentSuggestions.map((currentSuggestion) =>
        currentSuggestion.id === suggestion.id
          ? { ...currentSuggestion, status: nextStatus }
          : currentSuggestion
      )
    );
    setBusyId(null);
    setStatus("Ready");
    setMessage(nextStatus === "approved" ? "Update approved." : "Update rejected.");
  }

  async function runK12Research() {
    if (!canRunResearch) {
      setStatus("Not configured");
      setMessage(`${activeModuleTitle} research automation is not configured yet.`);
      return;
    }

    if (!selectedRecordIds.length) {
      setStatus("Selection needed");
      setMessage(`Select at least one ${activeEntityLabel}.`);
      return;
    }

    setIsAutomationRunning(true);
    setStatus("Loading");
    const recordIdsForRun = selectedRecordIds.slice(0, maxResearchSelection);
    setMessage(`Scanning ${recordIdsForRun.length} ${activeEntityLabel}s for ${activeWorkflow.label}.`);

    const response = await fetch("/api/automation/k12-research", {
      body: JSON.stringify({
        limit: maxResearchSelection,
        module: activeModuleKey,
        recordIds: recordIdsForRun,
        workflow: activeWorkflow.key
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });
    const result = (await response.json()) as {
      created?: number;
      diagnostics?: Array<{ institution: string; message: string }>;
      error?: string;
      errors?: Array<{ institution: string; error: string }>;
      extractors?: Array<"anthropic" | "openai" | "perplexity">;
      providerErrors?: Array<{ error: string; institution: string; provider: "anthropic" | "openai" | "perplexity" }>;
      eligible?: number;
      limit?: number;
      minimumDealYear?: number | null;
      preferredDealYear?: number | null;
      scanned?: number;
      selected?: number;
      skippedPending?: number;
      sourceCount?: number;
      sourceCandidates?: InstitutionSourceCandidates[];
    };

    if (!response.ok) {
      setIsAutomationRunning(false);
      setStatus("Sync error");
      setMessage(result.error ?? "Automation failed.");
      return;
    }

    await loadSuggestions();
    setSourceCandidates(result.sourceCandidates ?? []);
    setIsAutomationRunning(false);
    setStatus("Ready");
    const providerText = result.extractors?.length
      ? ` Providers: ${result.extractors.map(providerLabel).join(", ")}.`
      : "";
    const providerErrorText = result.providerErrors?.length
      ? ` Provider issues: ${summarizeProviderErrors(result.providerErrors)}.`
      : "";
    const diagnosticText = result.diagnostics?.length
      ? ` Notes: ${summarizeDiagnostics(result.diagnostics)}.`
      : "";
    const eligibleCount = result.eligible ?? result.scanned ?? 0;
    const runLimit = result.limit ?? maxResearchSelection;
    const selectedCount = result.selected ?? recordIdsForRun.length;
    const minimumDealYearText = result.minimumDealYear
      ? ` Deal-team suggestions are newest-first: ${result.preferredDealYear ?? 2025}+ is preferred, and ${
          result.minimumDealYear
        }+ older deals are fallback only.`
      : "";
    const skippedPendingText = result.skippedPending
      ? ` Skipped ${result.skippedPending} selected ${activeEntityLabel}${
          result.skippedPending === 1 ? "" : "s"
        } because this workflow already has pending suggestions for all requested fields.`
      : "";

    setMessage(
      `Scanned ${result.scanned ?? 0} of ${eligibleCount} eligible ${activeEntityLabel}s from ${
        selectedCount
      } selected, checked ${result.sourceCount ?? 0} sources, and created ${
        result.created ?? 0
      } suggestions. Max ${runLimit} per run.${minimumDealYearText}${skippedPendingText}${diagnosticText}${providerText}${providerErrorText}`
    );
  }

  function toggleInstitution(recordId: string) {
    if (selectedRecordIdSet.has(recordId)) {
      setSelectedRecordIds(selectedRecordIds.filter((currentId) => currentId !== recordId));
      return;
    }

    if (selectedRecordIds.length >= maxResearchSelection) {
      setStatus("Selection limit");
      setMessage(`One research run can include up to ${maxResearchSelection} selected ${activeEntityLabel}s.`);
      return;
    }

    setSelectedRecordIds([...selectedRecordIds, recordId]);
  }

  function selectAllInstitutions() {
    const nextIds = activeRows.slice(0, maxResearchSelection).map((row) => row.id);
    setSelectedRecordIds(nextIds);
    setStatus("Ready");
    setMessage(`Selected first ${nextIds.length} ${activeEntityLabel}s. One run can scan up to ${maxResearchSelection}.`);
  }

  function selectVisibleInstitutions() {
    const baseIds = selectedRecordIds.slice(0, maxResearchSelection);
    const remainingSlots = maxResearchSelection - baseIds.length;

    if (remainingSlots <= 0) {
      setStatus("Selection limit");
      setMessage(`One research run can include up to ${maxResearchSelection} selected ${activeEntityLabel}s.`);
      return;
    }

    const visibleIdsToAdd = filteredRows
      .map((row) => row.id)
      .filter((recordId) => !baseIds.includes(recordId))
      .slice(0, remainingSlots);
    const nextIds = [...baseIds, ...visibleIdsToAdd];
    setSelectedRecordIds(nextIds);
    setStatus("Ready");
    setMessage(`Selected ${nextIds.length}/${maxResearchSelection} ${activeEntityLabel}s for this run.`);
  }

  function clearInstitutions() {
    setSelectedRecordIds([]);
  }

  return (
    <div className={isSidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <WorkbookSidebar
        activeKey="updates"
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((current) => !current)}
      />
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeModuleTitle}</p>
            <h1>Update Center</h1>
          </div>
          <div className="topbar-actions">
            <div className="topbar-meta">
              <span>{pendingCount} pending</span>
              <span>{moduleSuggestions.length} total</span>
              <span title={message}>{status}</span>
            </div>
          </div>
        </header>

        <section className="update-surface" aria-label="Update review queue">
          {isSupabaseConfigured() ? (
            <>
              <div className="automation-panel">
                <div className="module-tabs" role="tablist" aria-label="Update Center modules">
                  {moduleTabs.map((tab) => (
                    <button
                      className={tab.key === activeModuleKey ? "module-tab active" : "module-tab"}
                      key={tab.key}
                      onClick={() => setActiveModuleKey(tab.key)}
                      type="button"
                    >
                      <strong>{tab.label}</strong>
                      <span>{tab.description}</span>
                    </button>
                  ))}
                </div>

                <div className="workflow-tabs" role="tablist" aria-label={`${activeModuleTitle} research groups`}>
                  {activeWorkflows.map((workflow) => (
                    <button
                      className={workflow.key === activeWorkflow.key ? "workflow-tab active" : "workflow-tab"}
                      key={workflow.key}
                      onClick={() => {
                        setActiveWorkflowKey(workflow.key);
                        setSourceCandidates([]);
                      }}
                      type="button"
                    >
                      {workflow.label}
                    </button>
                  ))}
                </div>

                <div className="automation-grid">
                  <div className="institution-panel">
                    <div className="institution-toolbar">
                      <label className="search-box">
                        <Search size={14} aria-hidden="true" />
                        <input
                          aria-label={`Search ${activeModuleTitle} ${activeEntityLabel}s`}
                          onChange={(event) => setInstitutionQuery(event.target.value)}
                          placeholder={`Find ${activeEntityLabel}`}
                          value={institutionQuery}
                        />
                      </label>
                      <button
                        className="table-icon-button text-button"
                        onClick={selectAllInstitutions}
                        title={`Select the first ${maxResearchSelection} ${activeEntityLabel}s`}
                        type="button"
                      >
                        First {maxResearchSelection}
                      </button>
                      <button
                        className="table-icon-button text-button"
                        onClick={selectVisibleInstitutions}
                        title={`Add visible ${activeEntityLabel}s up to ${maxResearchSelection} total`}
                        type="button"
                      >
                        Visible
                      </button>
                      <button className="table-icon-button text-button" onClick={clearInstitutions} type="button">
                        Clear
                      </button>
                    </div>

                    <div className="institution-list" aria-label={`${activeModuleTitle} ${activeEntityLabel}s`}>
                      {filteredRows.map((row) => (
                        <label className="institution-option" key={row.id}>
                          <input
                            checked={selectedRecordIdSet.has(row.id)}
                            onChange={() => toggleInstitution(row.id)}
                            type="checkbox"
                          />
                          <span>
                            <strong>{row.title}</strong>
                            <small>{recordMeta(row, activeModuleKey)}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="automation-run-panel">
                    <div>
                      <p className="eyebrow">{activeModuleTitle} research</p>
                      <h2>{activeWorkflow.label}</h2>
                      <p className="cadence-note">{activeWorkflow.cadence}</p>
                    </div>
                    {activeWorkflow.key === "deal-team" ? (
                      <ol className="research-flow" aria-label="Deal research flow">
                        <li>
                          <span>1</span>Find deal candidates
                        </li>
                        <li>
                          <span>2</span>Rank sources
                        </li>
                        <li>
                          <span>3</span>Read PDF/pages
                        </li>
                        <li>
                          <span>4</span>Extract package
                        </li>
                        <li>
                          <span>5</span>Review
                        </li>
                      </ol>
                    ) : null}
                    <div className="field-chip-row">
                      {activeWorkflow.fields.map((field) => (
                        <span key={field}>{fieldLabel(activeModuleKey, field)}</span>
                      ))}
                    </div>
                    <div className="automation-stats">
                      <span>{selectedRecordIds.length}/{maxResearchSelection} selected</span>
                      <span>{canRunResearch ? `max ${maxResearchSelection}/run` : "not configured"}</span>
                      <span>{activePendingCount} pending</span>
                    </div>
                    <p className="cadence-note">
                      One run scans up to {maxResearchSelection} selected {activeEntityLabel}s. Change the selection for another batch.
                    </p>
                    <button
                      className="run-button"
                      disabled={isAutomationRunning || !selectedRecordIds.length || !canRunResearch}
                      onClick={runK12Research}
                      type="button"
                    >
                      <Search size={15} aria-hidden="true" />
                      <span>{isAutomationRunning ? "Scanning..." : canRunResearch ? "Run research" : "Not configured"}</span>
                    </button>
                    <p className={status === "Sync error" ? "sync-message error" : "sync-message"}>{message}</p>
                    {sourceCandidates.length ? (
                      <div className="source-candidates">
                        <div className="source-candidates-head">
                          <p className="eyebrow">Source candidates</p>
                          <span>{sourceCandidates.reduce((sum, group) => sum + group.sources.length, 0)} sources</span>
                        </div>
                        <div className="source-candidate-groups">
                          {sourceCandidates.map((group) => (
                            <details className="source-candidate-group" key={group.institution}>
                              <summary>
                                <strong>{group.institution}</strong>
                                <span>{sourceCandidateSummary(group.sources)}</span>
                              </summary>
                              <div className="source-candidate-list">
                                {group.sources.map((source) => (
                                  <div className={`source-candidate ${source.status}`} key={`${group.institution}-${source.url}`}>
                                    <div className="source-candidate-main">
                                      <span className="source-status-pill">{sourceCandidateStatusLabel(source.status)}</span>
                                      <span className="source-category-pill">{sourceCategoryLabel(source.category)}</span>
                                      <a href={source.url} target="_blank" rel="noreferrer">
                                        <ExternalLink size={11} aria-hidden="true" />
                                        <strong>{source.title || "Source"}</strong>
                                      </a>
                                    </div>
                                    <p>{source.reason} Score {source.score}.</p>
                                    {source.snippet ? <small>{source.snippet}</small> : null}
                                  </div>
                                ))}
                              </div>
                            </details>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="update-list">
                <div className="review-toolbar">
                  <div>
                    <p className="eyebrow">Review queue</p>
                    <h2>{visibleSuggestions.length} shown</h2>
                  </div>
                  <div className="review-filter-tabs" aria-label="Review status filter">
                    {reviewStatusFilters.map((filter) => (
                      <button
                        className={reviewStatusFilter === filter.key ? "review-filter active" : "review-filter"}
                        key={filter.key}
                        onClick={() => setReviewStatusFilter(filter.key)}
                        type="button"
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>

                {groupedVisibleSuggestions.length ? (
                  groupedVisibleSuggestions.map((group) => (
                    <section className="review-group" key={group.recordId}>
                      <div className="review-group-head">
                        <div>
                          <p className="eyebrow">{activeModuleTitle}</p>
                          <h2>{group.title}</h2>
                        </div>
                        <span>{group.suggestions.length} items</span>
                      </div>

                      <div className="review-table" role="table" aria-label={`${group.title} update suggestions`}>
                        <div className="review-row review-row-head" role="row">
                          <span role="columnheader">Field</span>
                          <span role="columnheader">Current</span>
                          <span role="columnheader">Proposed</span>
                          <span role="columnheader">Source</span>
                          <span role="columnheader">Action</span>
                        </div>
                        {group.suggestions.map((suggestion) => (
                          <div className="review-row" key={suggestion.id} role="row">
                            <div className="review-field" role="cell">
                              <strong>{fieldLabel(suggestion.module, suggestion.field_key)}</strong>
                              <span className={`review-status ${suggestion.status}`}>{suggestion.status}</span>
                            </div>
                            <div className="review-cell-value" role="cell">
                              {suggestion.current_value || "-"}
                            </div>
                            <div className="review-cell-value proposed" role="cell">
                              {suggestion.proposed_value || "-"}
                            </div>
                            <div className="review-source" role="cell">
                              <div className="review-source-meta">
                                {typeof suggestion.confidence === "number" ? (
                                  <span>{Math.round(suggestion.confidence * 100)}%</span>
                                ) : null}
                                {suggestion.source_url ? (
                                  <a href={suggestion.source_url} target="_blank" rel="noreferrer">
                                    <ExternalLink size={12} aria-hidden="true" />
                                    <span>{suggestion.source_title || "Source"}</span>
                                  </a>
                                ) : null}
                              </div>
                              {suggestion.source_excerpt ? (
                                <details className="evidence-details">
                                  <summary>Evidence</summary>
                                  <p>{suggestion.source_excerpt}</p>
                                </details>
                              ) : null}
                            </div>
                            <div className="review-row-actions" role="cell">
                              {suggestion.status === "pending" ? (
                                <>
                                  <button
                                    className="review-button"
                                    onClick={() => reviewSuggestion(suggestion, "rejected")}
                                    disabled={busyId === suggestion.id}
                                    type="button"
                                  >
                                    <X size={14} aria-hidden="true" />
                                    <span>Reject</span>
                                  </button>
                                  <button
                                    className="review-button strong"
                                    onClick={() => reviewSuggestion(suggestion, "approved")}
                                    disabled={busyId === suggestion.id}
                                    type="button"
                                  >
                                    <Check size={14} aria-hidden="true" />
                                    <span>Approve</span>
                                  </button>
                                </>
                              ) : (
                                <span className="review-history-label">{suggestion.status}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="empty-state">
                    <p className="eyebrow">Review queue</p>
                    <h2>No updates in this view</h2>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <p className="eyebrow">Setup required</p>
              <h2>Connect Supabase</h2>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function fieldLabel(moduleKey: ModuleKey, fieldKey: string) {
  const column = moduleColumns[moduleKey].find((candidateColumn) => candidateColumn.key === fieldKey);

  if (!column) {
    return fieldKey;
  }

  return column.fullName ? `${column.label} (${column.fullName})` : column.label;
}

function entityLabel(moduleKey: ModuleKey) {
  if (moduleKey === "ccd-targets") {
    return "CCD";
  }

  if (moduleKey === "plans") {
    return "issuer";
  }

  return "institution";
}

function recordMeta(row: WorkspaceRecord, moduleKey: ModuleKey) {
  if (moduleKey === "k12-targets") {
    return String(row.fields.Area ?? "-") || "-";
  }

  return row.subtitle || "-";
}

function providerLabel(provider: "anthropic" | "openai" | "perplexity") {
  if (provider === "anthropic") {
    return "Claude";
  }

  if (provider === "openai") {
    return "OpenAI";
  }

  return "Perplexity";
}

function summarizeProviderErrors(
  providerErrors: Array<{ error: string; institution: string; provider: "anthropic" | "openai" | "perplexity" }>
) {
  return providerErrors
    .slice(0, 3)
    .map((providerError) => {
      const error = providerError.error ? ` (${providerError.error.slice(0, 90)})` : "";

      return `${providerError.institution}: ${providerLabel(providerError.provider)}${error}`;
    })
    .join("; ");
}

function summarizeDiagnostics(diagnostics: Array<{ institution: string; message: string }>) {
  return diagnostics
    .slice(0, 3)
    .map((diagnostic) => `${diagnostic.institution}: ${diagnostic.message}`)
    .join("; ");
}

function sourceCandidateStatusLabel(status: SourceCandidate["status"]) {
  if (status === "kept") {
    return "Kept";
  }

  if (status === "not_selected") {
    return "Not selected";
  }

  return "Excluded";
}

function sourceCategoryLabel(category: SourceCandidate["category"]) {
  if (category === "emma_os_pos") {
    return "EMMA / OS / POS";
  }

  if (category === "cdiac_debtwatch") {
    return "CDIAC / DebtWatch";
  }

  if (category === "board_materials") {
    return "Board materials";
  }

  if (category === "transaction_pages") {
    return "Transactions";
  }

  if (category === "issuer_site") {
    return "Issuer site";
  }

  return "Supplemental";
}

function sourceCandidateSummary(sources: SourceCandidate[]) {
  const kept = sources.filter((source) => source.status === "kept").length;
  const notSelected = sources.filter((source) => source.status === "not_selected").length;
  const excluded = sources.filter((source) => source.status === "excluded").length;

  return `${kept} kept / ${notSelected} lower-ranked / ${excluded} excluded`;
}
