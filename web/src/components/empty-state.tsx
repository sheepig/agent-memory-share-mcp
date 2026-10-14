import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  description: string;
  icon: LucideIcon;
  title: string;
}

export function EmptyState({ description, icon: Icon, title }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon aria-hidden="true" size={21} /></div>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}
