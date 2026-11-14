/**
 * Google's system code scanner (Play services): no camera permission and no
 * camera UI of our own. Resolves with the scanned text, or null when the
 * person backs out.
 */
import { CameraView } from "expo-camera";

export const canScanQr = (): boolean => CameraView.isModernBarcodeScannerAvailable;

export async function scanQr(): Promise<string | null> {
  let deliver: (text: string) => void = () => {};
  const scanned = new Promise<string>((resolve) => { deliver = resolve; });
  // The text arrives as an event; launchScanner resolves on the same success
  // but over another channel, so neither is assumed to land first.
  const subscription = CameraView.onModernBarcodeScanned((event) => deliver(event.data));
  try {
    await CameraView.launchScanner({ barcodeTypes: ["qr"] });
    return await Promise.race([scanned, new Promise<null>((resolve) => setTimeout(resolve, 2_000, null))]);
  } catch (err) {
    const message = (err as Error).message;
    if (/cancel/i.test(message)) return null;
    if (/Play Services/i.test(message))
      throw new Error("The QR scanner needs Google Play services. Type the address instead.");
    // Sideloaded apps fetch Google's scanner module on first use.
    throw new Error("The scanner is still getting ready. Try again in a moment, or type the address.");
  } finally {
    subscription.remove();
  }
}
