import type { ComponentProps } from "react";
import { SessionSidebar } from "./SessionSidebar";

/**
 * Stable inventory boundary. Fetching, optimistic session mutations, tombstones,
 * and navigation authority remain in the App coordinator during step 3.
 */
export type SessionInventoryProps = ComponentProps<typeof SessionSidebar>;

export function SessionInventory(props: SessionInventoryProps) {
  return <SessionSidebar {...props} />;
}
