const { withAppBuildGradle } = require("expo/config-plugins");

// React Native's default bundle inputs cover the app directory. Our shared
// transport lives outside it, so edits there must invalidate release bundles.
module.exports = (config) => withAppBuildGradle(config, (config) => {
  const marker = "// burn: shared workspace bundle inputs";
  if (!config.modResults.contents.includes(marker)) {
    config.modResults.contents += `\n${marker}
tasks.matching { it.name.startsWith('createBundle') && it.name.endsWith('JsAndAssets') }.configureEach {
    inputs.dir(new File(rootDir, '../../../packages/sync-api/src'))
}
`;
  }
  return config;
});
