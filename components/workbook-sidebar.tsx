"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, Database, ListChecks, Target, Table2 } from "lucide-react";
import { modules, type ModuleKey } from "@/lib/data";

type NavKey = ModuleKey | "updates";

const icons = {
  "k12-targets": Target,
  "ccd-targets": Database,
  plans: Table2
};

export function WorkbookSidebar({
  activeKey,
  isCollapsed,
  onToggle
}: {
  activeKey: NavKey;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand">
          <div className="brand-mark">K</div>
          <div className="brand-copy">
            <strong>Workbook</strong>
            <span>FY25 / FY26</span>
          </div>
        </div>
        <button
          className="collapse-button"
          onClick={onToggle}
          title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>

      <nav className="nav" aria-label="Workbook sheets">
        {modules.map((module) => {
          const Icon = icons[module.key];
          return (
            <Link
              key={module.key}
              href={module.href}
              title={module.title}
              className={module.key === activeKey ? "nav-item active" : "nav-item"}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{module.title}</span>
              <small>{module.kicker}</small>
            </Link>
          );
        })}
        <Link
          href="/updates"
          title="Update Center"
          className={activeKey === "updates" ? "nav-item active" : "nav-item"}
        >
          <ListChecks size={18} aria-hidden="true" />
          <span>Update Center</span>
          <small>Review queue</small>
        </Link>
      </nav>
    </aside>
  );
}
