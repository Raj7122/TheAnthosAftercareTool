import type { ReactNode } from "react";

import "./globals.css";
import { IframeConnectivityBootstrap } from "./_components/connectivity/IframeConnectivityBootstrap";
import { OfflineQueueIndicator } from "./_components/offline/OfflineQueueIndicator";
import { OutboxReplayer } from "./_components/offline/OutboxReplayer";
import { PWABootstrap } from "./_components/offline/PWABootstrap";
import { SyncObserver } from "./_components/offline/SyncObserver";

export const metadata = {
  title: "Anthos|Home Aftercare",
  description: "Caseworker tooling for the Anthos|Home Aftercare program.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PWABootstrap />
        <SyncObserver />
        <OutboxReplayer />
        <OfflineQueueIndicator />
        <IframeConnectivityBootstrap>{children}</IframeConnectivityBootstrap>
      </body>
    </html>
  );
}
