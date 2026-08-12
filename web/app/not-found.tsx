import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-20">
      <p className="stamp text-stamp">No such page</p>
      <h1 className="mt-3 font-serif text-2xl text-ink">
        That address is not part of the record.
      </h1>
      <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">
        ← Docket
      </Link>
    </div>
  );
}
