{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    obelisk = {
      url = "github:obeli-sk/obelisk/latest";
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
          pkgs = import nixpkgs { inherit system ; };
          commonDeps = with pkgs; [
            just
          ];
          withObelisk = commonDeps ++ [ obelisk.packages.${system}.default ];
        in
        {
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = withObelisk;
          };
        }
      );
}
