{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs = {
        nixpkgs.follows = "nixpkgs";
      };
    };
    obelisk = {
      url = "github:obeli-sk/obelisk/latest";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        flake-utils.follows = "flake-utils";
        rust-overlay.follows = "rust-overlay";
      };
    };
  };
  outputs = { self, nixpkgs, flake-utils, rust-overlay, obelisk }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          overlays = [ (import rust-overlay) ];
          pkgs = import nixpkgs {
            inherit system overlays;
          };
          rustToolchain = pkgs.pkgsBuildHost.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
          screenshotFonts = pkgs.makeFontsConf {
            fontDirectories = [ pkgs.dejavu_fonts ];
          };
          commonDeps = with pkgs; [
            cargo-edit
            cargo-expand
            cargo-insta
            cargo-nextest
            just
            jq
            pkg-config
            rustToolchain
            wasm-tools
            wasmtime.out
            # JS runtimes (just-bash / workflow migration still in progress)
            nodejs
            pnpm
          ];
          withObelisk = commonDeps ++ [ obelisk.packages.${system}.default ];
        in
        {
          devShells.noObelisk = pkgs.mkShell {
            nativeBuildInputs = commonDeps;
          };
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = withObelisk;
          };
          devShells.screenshots = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              playwright-test
            ];
            shellHook = ''
              export NODE_PATH=${pkgs.playwright-test}/lib/node_modules''${NODE_PATH:+:$NODE_PATH}
              export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
              export FONTCONFIG_FILE=${screenshotFonts}
            '';
          };
        }
      );
}
