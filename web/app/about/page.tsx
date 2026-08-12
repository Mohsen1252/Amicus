import type { Metadata } from "next";

import { ProtocolDocs } from "@/components/protocol-docs";

export const metadata: Metadata = {
  title: "How Amicus works",
  description:
    "What the Amicus contract does, how a case moves from proposal to payout, and how " +
    "GenLayer's leader and validator consensus reaches a judgment.",
};

export default function AboutPage() {
  return <ProtocolDocs />;
}
