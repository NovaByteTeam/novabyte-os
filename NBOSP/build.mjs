import("nw-builder").then(({ default: nwbuild }) => {
  nwbuild({
    mode: "build",
    srcDir: "C:/Users/diraz/Downloads/novabyte-os/NBOSP",
    glob: false,
    platform: "win",
    arch: "x64",
    outDir: "C:/Users/diraz/Downloads/novabyte-os/build"
  });
}).catch((error) => {
  console.error(error);
});