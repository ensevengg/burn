import type { Alert } from "react-native";

/** Native dialog is the action boundary: cancel, back, and outside dismissal
 * perform no writes. Observe failures rather than leaving rejected UI promises. */
export function confirmDestructive(
  dialog: Pick<typeof Alert, "alert">,
  title: string,
  message: string,
  action: () => Promise<void>,
): void {
  let settled = false;
  const cancel = () => {
    settled = true;
  };
  dialog.alert(
    title,
    message,
    [
      { text: "Cancel", style: "cancel", onPress: cancel },
      {
        text: "Yes",
        style: "destructive",
        onPress: () => {
          if (settled) return;
          settled = true;
          void Promise.resolve()
            .then(action)
            .catch((error: unknown) => {
              dialog.alert(
                "Action failed",
                error instanceof Error ? error.message : String(error),
              );
            });
        },
      },
    ],
    { cancelable: true, onDismiss: cancel },
  );
}
