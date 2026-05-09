"use client";

import { HardHat, Wrench, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Role } from "@/app/page";

interface RoleTabsProps {
  selectedRole: Role;
  onRoleChange: (role: Role) => void;
}

const roles = [
  {
    id: "miner" as Role,
    label: "Người đào",
    icon: HardHat,
    description: "Tập trung vào khai thác và xây dựng",
  },
  {
    id: "engineer" as Role,
    label: "Kỹ sư",
    icon: Wrench,
    description: "Thiết kế và phân tích kỹ thuật",
  },
  {
    id: "operator" as Role,
    label: "Vận hành viên",
    icon: Gauge,
    description: "Giám sát và vận hành hệ thống",
  },
];

export function RoleTabs({ selectedRole, onRoleChange }: RoleTabsProps) {
  return (
    <div className="border-b border-border bg-card/50 px-4">
      <div className="flex gap-1">
        {roles.map((role) => {
          const Icon = role.icon;
          const isSelected = selectedRole === role.id;

          return (
            <button
              key={role.id}
              onClick={() => onRoleChange(role.id)}
              className={cn(
                "group flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all",
                "border-b-2 -mb-px",
                isSelected
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 transition-colors",
                  isSelected
                    ? "text-primary"
                    : "text-muted-foreground group-hover:text-foreground"
                )}
              />
              <span>{role.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
