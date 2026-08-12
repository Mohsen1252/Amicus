import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from "next/font/google";

import { ConfigGate } from "@/components/config-gate";
import { DataProvider } from "@/components/data-provider";
import { SiteHeader } from "@/components/site-header";
import { WalletProvider } from "@/components/wallet";
import "./globals.css";

const sans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const serif = IBM_Plex_Serif({
  variable: "--font-plex-serif",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Amicus",
  description:
    "A public record of agreements settled by the Amicus contract, and the judgments that settled them.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${serif.variable} ${mono.variable} h-full`}
    >
      <head>
        {/*
          Applied before paint so the page does not flash the wrong scheme.
          Inline because it has to run ahead of hydration; it reads a stored
          preference and sets a class, nothing more.
        */}
        <script
          id="amicus-theme"
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("amicus-theme");var d=window.matchMedia("(prefers-color-scheme: dark)").matches;if(s==="dark"||(s!=="light"&&d)){document.documentElement.classList.add("dark")}}catch(e){}})();`,
          }}
        />
      </head>
      <body className="flex min-h-full flex-col antialiased">
        <ConfigGate>
          <DataProvider>
          <WalletProvider>
            <div className="mx-auto flex min-h-full w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
              <SiteHeader />
              <main className="flex-1 pb-20">{children}</main>
              <footer className="border-t border-rule py-6 text-xs text-ink-faint">
                Amicus reports what the contract recorded. It does not judge, predict, or
                estimate.
              </footer>
            </div>
          </WalletProvider>
          </DataProvider>
        </ConfigGate>
      </body>
    </html>
  );
}
