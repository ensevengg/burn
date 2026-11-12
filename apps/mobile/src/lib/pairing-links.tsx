import { useEffect, useRef, useState } from "react";
import { Alert, Linking } from "react-native";
import { useApp } from "./app-context";
import { confirmDestructive } from "./confirm-destructive";
import { parsePairingCode } from "./pairing";

/**
 * Opens the add sheet for a `burn://add?url=…` link (a pairing QR code read
 * by another scanner). The person still taps Add, and the machine is still
 * validated by /ping. Leaving demo data asks first, as clearing it always does.
 */
export function PairingLinks() {
  const { db, mode, connectDirect, setPairing } = useApp();
  const [pending, setPending] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    const take = (link: string | null) => {
      const url = link === null ? null : parsePairingCode(link);
      if (url !== null) setPending(url);
    };
    if (!handled.current) {
      handled.current = true;
      void Linking.getInitialURL().then(take, () => {});
    }
    const subscription = Linking.addEventListener("url", ({ url }) => take(url));
    return () => subscription.remove();
  }, []);

  // Waits for the database, so a link that cold-starts the app still lands.
  useEffect(() => {
    const url = pending;
    if (url === null || db === null) return;
    setPending(null);
    if (mode === "direct") setPairing(url);
    else if (mode === "unconfigured") void connectDirect().then(() => setPairing(url));
    else
      confirmDestructive(
        Alert,
        "Leave demo data?",
        "Adding your own machine clears the demo data from this phone.",
        async () => {
          await connectDirect();
          setPairing(url);
        },
      );
  }, [pending, db, mode, connectDirect, setPairing]);

  return null;
}
