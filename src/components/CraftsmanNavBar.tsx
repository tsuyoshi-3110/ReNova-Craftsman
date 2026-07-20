// src/components/CraftsmanNavBar.tsx
"use client";

import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogIn, MapPin, Settings, Building2 } from "lucide-react";

const TABS = [
  { href: "/projects", label: "工事一覧", icon: Building2 },
  { href: "/weather", label: "現在地情報", icon: MapPin },
  { href: "/settings/profile", label: "設定", icon: Settings },
  { href: "/login", label: "ログイン", icon: LogIn },
] as const;

export default function CraftsmanNavBar() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <nav
      className="craftsman-nav fixed inset-x-0 bottom-0 z-40 border-t bg-white dark:border-gray-800 dark:bg-gray-950"
      style={{
        height: "var(--craftsman-nav-height)",
        paddingBottom: "env(safe-area-inset-bottom)",
        boxSizing: "border-box",
      }}
    >
      <div className="mx-auto grid h-full w-full max-w-md grid-cols-4">
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
              aria-label={tab.label}
              aria-current={active ? "page" : undefined}
              title={tab.label}
              className={`flex h-full items-center justify-center transition active:scale-95 ${
                active
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-gray-400 hover:text-gray-900 dark:text-gray-500 dark:hover:text-gray-100"
              }`}
            >
              <tab.icon className="h-6 w-6" strokeWidth={active ? 2.6 : 2} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
