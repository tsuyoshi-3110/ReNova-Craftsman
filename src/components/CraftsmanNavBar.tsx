// src/components/CraftsmanNavBar.tsx
"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";

const TABS = [
  { href: "/projects", label: "工事一覧" },
  { href: "/settings/profile", label: "設定" },
] as const;

export default function CraftsmanNavBar() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-white dark:border-gray-800 dark:bg-gray-950"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto grid w-full max-w-md grid-cols-2">
        {TABS.map((tab) => {
          const active =
            tab.href === "/projects"
              ? pathname === "/projects"
              : pathname.startsWith(tab.href);
          return (
            <button
              key={tab.href}
              type="button"
              onClick={() => {
                if (!active) router.push(tab.href);
              }}
              className={`py-4 text-sm font-extrabold ${
                active
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
