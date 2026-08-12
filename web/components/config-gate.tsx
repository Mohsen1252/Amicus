import { configResult, isConfigError } from "@/lib/config";

/**
 * Refuses to render the app when it is not pointed at a contract.
 *
 * A misconfigured Amicus would otherwise render a calm, empty case list, which
 * is indistinguishable from a network with no disputes on it. That is the worst
 * failure this interface has, because it looks like an answer.
 */
export function ConfigGate({ children }: { children: React.ReactNode }) {
  if (!isConfigError(configResult)) return <>{children}</>;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-1 items-center px-6 py-20">
      <div className="w-full border border-flag bg-flag-wash p-8">
        <p className="stamp text-flag">Not configured</p>
        <h1 className="mt-4 font-serif text-2xl text-ink">
          Amicus does not know which contract to read.
        </h1>
        <dl className="mt-6 space-y-3 text-sm">
          <div>
            <dt className="text-ink-muted">Variable</dt>
            <dd className="font-mono text-ink">{configResult.variable}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Problem</dt>
            <dd className="text-ink">{configResult.problem}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Fix</dt>
            <dd className="text-ink">{configResult.fix}</dd>
          </div>
        </dl>
        <p className="mt-6 border-t border-flag/40 pt-4 text-xs text-ink-muted">
          The app stops here on purpose. Reading the wrong address would show an empty
          case list, which looks the same as a network with no disputes on it.
        </p>
      </div>
    </div>
  );
}
