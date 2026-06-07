"use client";

import type { ReactNode } from "react";
import { agentColor, initials } from "../../lib/workbench/format";

export function AvatarFace({
  name,
  avatarUrl,
  colorKey,
  className = "",
  children,
}: {
  name: string;
  avatarUrl?: string | null;
  colorKey?: string | number | null;
  className?: string;
  children?: ReactNode;
}) {
  const imageUrl = avatarUrl?.trim();
  const classes = ["avatar", imageUrl && !children ? "imageAvatar" : "", className].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      style={imageUrl && !children ? undefined : { background: agentColor(colorKey ?? name) }}
    >
      {imageUrl && !children ? <img src={imageUrl} alt="" /> : children ?? initials(name)}
    </span>
  );
}
