import writeAppUpdateConfig from "./lib/app-update-config.mjs";
import verifyPackagedNativeHelpers from "./verify-packaged-native-helpers.mjs";

export default async function afterPack(context) {
  await writeAppUpdateConfig(context);
  verifyPackagedNativeHelpers(context);
}
