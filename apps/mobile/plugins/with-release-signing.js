const { withAppBuildGradle } = require("expo/config-plugins");

// Release APKs are signed with the key named by BURN_KEYSTORE (CI reads it
// from repository secrets; see .github/workflows/release.yml). Without it a
// release build keeps the template's debug signing, for local testing only.
module.exports = (config) => withAppBuildGradle(config, (config) => {
  const marker = "// burn: release signing from the environment";
  if (!config.modResults.contents.includes(marker)) {
    config.modResults.contents += `\n${marker}
if (System.getenv("BURN_KEYSTORE")) {
    android.signingConfigs.create("burnRelease") {
        storeFile file(System.getenv("BURN_KEYSTORE"))
        storePassword System.getenv("BURN_KEYSTORE_PASSWORD")
        keyAlias System.getenv("BURN_KEY_ALIAS")
        keyPassword System.getenv("BURN_KEY_PASSWORD")
    }
    android.buildTypes.release.signingConfig android.signingConfigs.burnRelease
}
`;
  }
  return config;
});
