"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  Download,
  LogOut,
  Plus,
  RotateCcw,
  Search
} from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  getLastUpdated,
  getModuleRows,
  getModuleTitle,
  moduleColumns,
  moduleFilterFields,
  type ColumnDef,
  type FieldValue,
  type ModuleKey,
  type WorkspaceRecord
} from "@/lib/data";
import { WorkbookSidebar } from "./workbook-sidebar";

type FilterState = {
  search: string;
  fieldOne: string;
  fieldTwo: string;
  fieldThree: string;
};

type SelectedCell = {
  rowId: string;
  key: string;
};

const initialFilters: FilterState = {
  search: "",
  fieldOne: "All",
  fieldTwo: "All",
  fieldThree: "All"
};

type SyncStatus = "Needs setup" | "Loading" | "Synced" | "Saving" | "Sync error";

type WorkbookFieldValue = {
  record_id: string;
  field_key: string;
  value: string | null;
  updated_at: string | null;
};

type WorkbookCustomRow = {
  id: string;
  module: ModuleKey;
  title: string;
  subtitle: string | null;
  kind: "section" | "record" | null;
  tone: "dark" | null;
  fields: Record<string, FieldValue> | null;
  updated_at: string | null;
};

export function Workspace({ moduleKey }: { moduleKey: ModuleKey }) {
  const baseRows = useMemo(() => getModuleRows(moduleKey), [moduleKey]);
  const columns = moduleColumns[moduleKey];
  const filterFields = moduleFilterFields[moduleKey];
  const title = getModuleTitle(moduleKey);
  const [rows, setRows] = useState<WorkspaceRecord[]>(baseRows);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    isSupabaseConfigured() ? "Loading" : "Needs setup"
  );
  const [syncMessage, setSyncMessage] = useState(
    isSupabaseConfigured()
      ? "Connected fields load from Supabase."
      : "Add Supabase env vars to enable login and persistent edits."
  );
  const [selectedCell, setSelectedCell] = useState<SelectedCell>({
    rowId: baseRows[0]?.id ?? "",
    key: columns[0]?.key ?? ""
  });

  useEffect(() => {
    let isCancelled = false;

    async function loadRows() {
      if (!isSupabaseConfigured()) {
        setRows(baseRows);
        setSyncStatus("Needs setup");
        setSyncMessage("Add Supabase env vars to enable login and persistent edits.");
        return;
      }

      const supabase = createSupabaseBrowserClient();

      if (!supabase) {
        return;
      }

      setSyncStatus("Loading");
      setSyncMessage("Loading saved field values.");

      const [{ data: fieldValues, error: fieldError }, { data: customRows, error: customError }] =
        await Promise.all([
          supabase
            .from("workbook_field_values")
            .select("record_id, field_key, value, updated_at")
            .eq("module", moduleKey),
          supabase
            .from("workbook_custom_rows")
            .select("id, module, title, subtitle, kind, tone, fields, updated_at")
            .eq("module", moduleKey)
            .order("row_order", { ascending: true })
        ]);

      if (isCancelled) {
        return;
      }

      if (fieldError || customError) {
        setRows(baseRows);
        setSyncStatus("Sync error");
        setSyncMessage("Run lib/schema.sql in Supabase, then refresh this page.");
        return;
      }

      const nextRows = mergeSupabaseRows(
        baseRows,
        (fieldValues ?? []) as WorkbookFieldValue[],
        (customRows ?? []) as WorkbookCustomRow[]
      );

      setRows(nextRows);
      setSelectedCell({
        rowId: nextRows[0]?.id ?? "",
        key: columns[0]?.key ?? ""
      });
      setSyncStatus("Synced");
      setSyncMessage("Saved edits are loaded from Supabase.");
    }

    loadRows();

    return () => {
      isCancelled = true;
    };
  }, [baseRows, columns, moduleKey]);

  const filteredRows = useMemo(() => {
    const query = filters.search.trim().toLowerCase();

    return rows.filter((row) => {
      const values = Object.values(row.fields).map(String);
      const textMatch =
        !query || [row.title, row.subtitle, ...values].join(" ").toLowerCase().includes(query);
      const filterOneMatch =
        filters.fieldOne === "All" || String(row.fields[filterFields[0]] ?? "") === filters.fieldOne;
      const filterTwoMatch =
        filters.fieldTwo === "All" || String(row.fields[filterFields[1]] ?? "") === filters.fieldTwo;
      const filterThreeMatch =
        filters.fieldThree === "All" || String(row.fields[filterFields[2]] ?? "") === filters.fieldThree;

      return textMatch && filterOneMatch && filterTwoMatch && filterThreeMatch;
    });
  }, [filterFields, filters, rows]);

  const selectedRow = rows.find((row) => row.id === selectedCell.rowId);
  const selectedValue = selectedRow ? String(selectedRow.fields[selectedCell.key] ?? "") : "";
  const selectedRowIndex = Math.max(
    0,
    filteredRows.findIndex((row) => row.id === selectedCell.rowId)
  );
  const selectedColumnIndex = Math.max(
    0,
    columns.findIndex((column) => column.key === selectedCell.key)
  );
  const selectedColumn = columns[selectedColumnIndex];
  const selectedCellLocked = isCellLocked(selectedRow, selectedColumn);
  const cellRef = `${columnName(selectedColumnIndex)}${selectedRowIndex + 1}`;

  function updateCell(rowId: string, key: string, value: string) {
    const currentRow = rows.find((row) => row.id === rowId);
    const currentColumn = columns.find((column) => column.key === key);

    if (isCellLocked(currentRow, currentColumn)) {
      return;
    }

    setRows((currentRows) =>
      currentRows.map((row) => {
        if (row.id !== rowId) {
          return row;
        }

        const nextFields = {
          ...row.fields,
          [key]: value
        };
        const firstColumn = columns[0]?.key;

        return {
          ...row,
          title: key === firstColumn ? value || row.title : row.title,
          updatedAt: new Date().toISOString().slice(0, 10),
          fields: nextFields
        };
      })
    );
  }

  async function persistCell(rowId: string, key: string, value: string) {
    const currentRow = rows.find((row) => row.id === rowId);
    const currentColumn = columns.find((column) => column.key === key);

    if (isCellLocked(currentRow, currentColumn)) {
      return;
    }

    if (!isSupabaseConfigured()) {
      setSyncStatus("Needs setup");
      setSyncMessage("Supabase is not configured, so this edit only lives in this browser session.");
      return;
    }

    const supabase = createSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    setSyncStatus("Saving");
    setSyncMessage("Saving field value.");

    const { error } = await supabase.from("workbook_field_values").upsert(
      {
        module: moduleKey,
        record_id: rowId,
        field_key: key,
        value,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: "record_id,field_key"
      }
    );

    if (error) {
      setSyncStatus("Sync error");
      setSyncMessage(error.message);
      return;
    }

    setSyncStatus("Synced");
    setSyncMessage("Field value saved.");
  }

  async function addRow() {
    const fields = Object.fromEntries(columns.map((column) => [column.key, ""]));
    const newRow: WorkspaceRecord = {
      id: `${moduleKey}-${Date.now()}`,
      module: moduleKey,
      title: "New row",
      subtitle: "Draft",
      updatedAt: new Date().toISOString().slice(0, 10),
      fields
    };

    setRows((currentRows) => [...currentRows, newRow]);
    setSelectedCell({ rowId: newRow.id, key: columns[0]?.key ?? "" });

    if (!isSupabaseConfigured()) {
      setSyncStatus("Needs setup");
      setSyncMessage("Supabase is not configured, so the new row is temporary.");
      return;
    }

    const supabase = createSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    setSyncStatus("Saving");
    setSyncMessage("Saving new row.");

    const { error } = await supabase.from("workbook_custom_rows").insert({
      id: newRow.id,
      module: moduleKey,
      title: newRow.title,
      subtitle: newRow.subtitle,
      kind: newRow.kind ?? "record",
      tone: newRow.tone ?? null,
      fields: newRow.fields,
      row_order: rows.length + 1,
      updated_at: new Date().toISOString()
    });

    if (error) {
      setSyncStatus("Sync error");
      setSyncMessage(error.message);
      return;
    }

    setSyncStatus("Synced");
    setSyncMessage("New row saved.");
  }

  async function signOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase?.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className={isSidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <WorkbookSidebar
        activeKey={moduleKey}
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((current) => !current)}
      />
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">K-12 workbook</p>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <div className="topbar-meta">
              <span>{filteredRows.length} visible rows</span>
              <span>{columns.length} columns</span>
              <span>Updated {getLastUpdated(rows) ?? "n/a"}</span>
              <span title={syncMessage}>{syncStatus}</span>
            </div>
            {isSupabaseConfigured() ? (
              <button className="logout-button" onClick={signOut} type="button">
                <LogOut size={14} aria-hidden="true" />
                <span>Sign out</span>
              </button>
            ) : null}
          </div>
        </header>

        <section className="sheet-surface" aria-label={`${title} spreadsheet`}>
          <SheetToolbar
            rows={rows}
            filteredRows={filteredRows}
            columns={columns}
            moduleKey={moduleKey}
            filters={filters}
            filterFields={filterFields}
            onFilterChange={setFilters}
            onReset={() => setFilters(initialFilters)}
            onAddRow={addRow}
          />

          <div className="formula-bar">
            <span className="cell-ref">{cellRef}</span>
            <input
              className={selectedCellLocked ? "system-formula-input" : undefined}
              value={selectedValue}
              onChange={(event) => {
                if (!selectedCellLocked) {
                  updateCell(selectedCell.rowId, selectedCell.key, event.target.value);
                }
              }}
              onBlur={(event) => {
                if (!selectedCellLocked) {
                  persistCell(selectedCell.rowId, selectedCell.key, event.target.value);
                }
              }}
              readOnly={selectedCellLocked}
              aria-label="Selected cell value"
            />
          </div>

          <div className="sheet-frame">
            <table className="spreadsheet-table" style={{ minWidth: getTableWidth(columns) }}>
              <thead>
                <tr className="column-letters">
                  <th className="row-corner" />
                  {columns.map((column, index) => (
                    <th key={column.key} style={{ width: column.width }}>
                      {columnName(index)}
                    </th>
                  ))}
                </tr>
                <tr className="field-row">
                  <th className="row-number">#</th>
                  {columns.map((column) => (
                    <th key={column.key} style={{ width: column.width }}>
                      <span className="field-label">
                        <span>{column.label}</span>
                        {column.fullName ? (
                          <span className="term-expansion">({column.fullName})</span>
                        ) : null}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row, rowIndex) => {
                  const rowNumber = rowIndex + 1;
                  const rowClassName = [
                    row.kind === "section" ? "section-row" : "",
                    row.tone === "dark" ? "dark-row" : ""
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <tr key={row.id} className={rowClassName || undefined}>
                      <th className="row-number">{rowNumber}</th>
                      {columns.map((column) => {
                        const isSelected =
                          selectedCell.rowId === row.id && selectedCell.key === column.key;
                        const isLocked = isCellLocked(row, column);
                        const cellClassName = [
                          isSelected ? "selected-cell" : "",
                          isLocked ? "system-cell" : ""
                        ]
                          .filter(Boolean)
                          .join(" ");

                        return (
                          <td key={column.key} className={cellClassName || undefined}>
                            <input
                              className="cell-input"
                              value={String(row.fields[column.key] ?? "")}
                              onFocus={() => setSelectedCell({ rowId: row.id, key: column.key })}
                              onChange={(event) => {
                                if (!isLocked) {
                                  updateCell(row.id, column.key, event.target.value);
                                }
                              }}
                              onBlur={(event) => {
                                if (!isLocked) {
                                  persistCell(row.id, column.key, event.target.value);
                                }
                              }}
                              readOnly={isLocked}
                              aria-label={`${column.label} row ${rowNumber}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function SheetToolbar({
  rows,
  filteredRows,
  columns,
  moduleKey,
  filters,
  filterFields,
  onFilterChange,
  onReset,
  onAddRow
}: {
  rows: WorkspaceRecord[];
  filteredRows: WorkspaceRecord[];
  columns: Array<{ key: string; label: string }>;
  moduleKey: ModuleKey;
  filters: FilterState;
  filterFields: string[];
  onFilterChange: (next: FilterState) => void;
  onReset: () => void;
  onAddRow: () => void;
}) {
  const options = useMemo(
    () => ({
      fieldOne: unique(rows.map((row) => String(row.fields[filterFields[0]] ?? "")).filter(Boolean)),
      fieldTwo: unique(rows.map((row) => String(row.fields[filterFields[1]] ?? "")).filter(Boolean)),
      fieldThree: unique(rows.map((row) => String(row.fields[filterFields[2]] ?? "")).filter(Boolean))
    }),
    [filterFields, rows]
  );

  return (
    <div className="sheet-toolbar" aria-label="Spreadsheet controls">
      <div className="search-box">
        <Search size={18} aria-hidden="true" />
        <input
          value={filters.search}
          onChange={(event) => onFilterChange({ ...filters, search: event.target.value })}
          placeholder="Search sheet"
        />
      </div>
      <SelectFilter
        label={filterFields[0]}
        value={filters.fieldOne}
        options={options.fieldOne}
        onChange={(fieldOne) => onFilterChange({ ...filters, fieldOne })}
      />
      <SelectFilter
        label={filterFields[1]}
        value={filters.fieldTwo}
        options={options.fieldTwo}
        onChange={(fieldTwo) => onFilterChange({ ...filters, fieldTwo })}
      />
      <SelectFilter
        label={filterFields[2]}
        value={filters.fieldThree}
        options={options.fieldThree}
        onChange={(fieldThree) => onFilterChange({ ...filters, fieldThree })}
      />
      <button className="icon-action" onClick={onReset} title="Reset filters" aria-label="Reset filters">
        <RotateCcw size={18} />
      </button>
      <button className="icon-action" onClick={onAddRow} title="Add row" aria-label="Add row">
        <Plus size={18} />
      </button>
      <button
        className="icon-action strong"
        onClick={() => exportCsv(filteredRows, columns, moduleKey)}
        title="Export CSV"
        aria-label="Export CSV"
      >
        <Download size={18} />
      </button>
      <button
        className="icon-action"
        onClick={() => copyCsv(filteredRows, columns)}
        title="Copy sheet"
        aria-label="Copy sheet"
      >
        <Clipboard size={18} />
      </button>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="select-filter">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="All">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function mergeSupabaseRows(
  baseRows: WorkspaceRecord[],
  fieldValues: WorkbookFieldValue[],
  customRows: WorkbookCustomRow[]
) {
  const fieldMap = new Map(
    fieldValues.map((fieldValue) => [
      `${fieldValue.record_id}::${fieldValue.field_key}`,
      fieldValue
    ])
  );

  const mergedBaseRows = baseRows.map((row) => {
    const fields = { ...row.fields };
    let updatedAt = row.updatedAt;

    moduleColumns[row.module].forEach((column) => {
      const savedField = fieldMap.get(`${row.id}::${column.key}`);

      if (!savedField || isCellLocked(row, column)) {
        return;
      }

      fields[column.key] = savedField.value ?? "";

      if (savedField.updated_at && savedField.updated_at > updatedAt) {
        updatedAt = savedField.updated_at.slice(0, 10);
      }
    });

    const firstColumn = moduleColumns[row.module][0]?.key;
    const title = firstColumn ? String(fields[firstColumn] ?? row.title) : row.title;

    return {
      ...row,
      title: title || row.title,
      updatedAt,
      fields
    };
  });

  const mergedCustomRows: WorkspaceRecord[] = customRows.map((row) => ({
    id: row.id,
    module: row.module,
    title: row.title,
    subtitle: row.subtitle ?? "Custom row",
    updatedAt: row.updated_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    kind: row.kind ?? "record",
    tone: row.tone ?? undefined,
    fields: fieldsForRow(row.module, row.fields ?? {})
  }));

  return [...mergedBaseRows, ...mergedCustomRows];
}

function isCellLocked(row?: WorkspaceRecord, column?: ColumnDef) {
  return Boolean(row?.isSystem && (row.kind === "section" || column?.isSystem));
}

function fieldsForRow(moduleKey: ModuleKey, values: Record<string, FieldValue>) {
  return Object.fromEntries(
    moduleColumns[moduleKey].map((column) => [column.key, values[column.key] ?? ""])
  );
}

function unique(values: string[]) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function getTableWidth(columns: Array<{ width?: number }>) {
  const rowNumberWidth = 54;
  return columns.reduce((sum, column) => sum + (column.width ?? 160), rowNumberWidth);
}

function columnName(index: number) {
  let name = "";
  let current = index + 1;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }

  return name;
}

function buildCsv(rows: WorkspaceRecord[], columns: Array<{ key: string; label: string }>) {
  return [
    columns.map((column) => csvEscape(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row.fields[column.key] ?? "")).join(","))
  ].join("\n");
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv(
  rows: WorkspaceRecord[],
  columns: Array<{ key: string; label: string }>,
  moduleKey: ModuleKey
) {
  const blob = new Blob([buildCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${moduleKey}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyCsv(rows: WorkspaceRecord[], columns: Array<{ key: string; label: string }>) {
  await navigator.clipboard.writeText(buildCsv(rows, columns));
}
