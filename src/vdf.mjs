// The AppBuild script steamcmd is handed. One FileMapping per depot that has a folder to send,
// each recursive so the structure — notably the macOS .app wrapper — survives the trip.
//
// SetLive is absent unless asked for. Steam rejects it on the default branch anyway, so shipping
// to everyone stays a deliberate click in the Steamworks UI, and a build that lands unpromoted can
// be looked at before it replaces anything.

export function buildVdf({ appId, depots, desc, dirs, contentRoot, buildOutput, live = "" }) {
  const slash = (p) => p.split("\\").join("/");
  const setLive = live ? `    "SetLive" "${live}"\n` : "";
  const mappings = Object.keys(dirs).map((platform) => `        "${depots[platform]}"
        {
            "FileMapping"
            {
                "LocalPath" "${dirs[platform]}/*"
                "DepotPath" "."
                "recursive" "1"
            }
        }`).join("\n");
  return `"AppBuild"
{
    "AppID" "${appId}"
    "Desc" "${desc}"
${setLive}    "BuildOutput" "${slash(buildOutput)}"
    "ContentRoot" "${slash(contentRoot)}"
    "Depots"
    {
${mappings}
    }
}
`;
}
