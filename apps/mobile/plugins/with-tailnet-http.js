const { withAndroidManifest, AndroidConfig } = require("expo/config-plugins");

// Reporter URLs may be HTTP: Tailscale encrypts the underlying connection.
// Expo has no android.usesCleartextTraffic config field; set the manifest explicitly.
module.exports = (config) => withAndroidManifest(config, (config) => {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
  application.$["android:usesCleartextTraffic"] = "true";
  return config;
});
