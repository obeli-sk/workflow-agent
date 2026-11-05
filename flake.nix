{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    obelisk = {
      url = "github:obeli-sk/obelisk/latest-rc";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        flake-utils.follows = "flake-utils";
      };
    };
  };
  outputs = { self, nixpkgs, flake-utils, obelisk }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
          screenshotFonts = pkgs.makeFontsConf {
            fontDirectories = [ pkgs.dejavu_fonts ];
          };
          commonDeps = with pkgs; [
            just
            gh # for scripts/sync-branch-protection.sh
            jq
            yq-go # for scripts/sync-branch-protection.sh
            ripgrep # for scripts/e2e-lib.sh
          ];
          withObelisk = commonDeps ++ [ obelisk.packages.${system}.default ];
        in
        {
          devShells.noObelisk = pkgs.mkShell {
            nativeBuildInputs = commonDeps;
          };
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = withObelisk ++ [
              pkgs.nodejs # for e2e test JSON handling
            ];
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
