/**
 * Google's system code scanner (Play services): no camera permission and no
 * camera UI of our own. Resolves with the scanned text, or null when the
 * person backs out.
 */
import { CameraView } from "expo-camera";

export const canScanQr = (): boolean => CameraView.isModernBarcodeScannerAvailable;

export async function scanQr(): Promise<string | null> {
  let scanned: string | null = null;
  // The scan event arrives before launchScanner resolves.
  const subscription = CameraView.onModernBarcodeScanned((event) => {
    scanned = event.data;
  });
  try {
    await CameraView.launchScanner({ barcodeTypes: ["qr"] });
    return scanned;
  } catch (err) {
    if (/cancel/i.test((err as Error).message)) return null;
    throw new Error("The QR scanner needs Google Play services. Type the address instead.");
  } finally {
    subscription.remove();
  }
}
