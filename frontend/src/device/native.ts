/** Native integration (Capacitor). Only loaded by the app build. */
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

export function setupNative(): void {
  if (!Capacitor.isNativePlatform()) return;
  // Android back button: go back in the app, leave it from the first screen.
  void App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) window.history.back();
    else void App.exitApp();
  });
}
