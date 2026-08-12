import { CaseDetail } from "@/components/case-detail";

/**
 * `params` is a Promise in Next.js 16; synchronous access was removed.
 * The route segment is decoded here and the detail view is a client component
 * because it reads the chain and drives the wallet.
 */
export default async function CasePage(props: PageProps<"/cases/[caseId]">) {
  const { caseId } = await props.params;
  return <CaseDetail caseId={decodeURIComponent(caseId)} />;
}
