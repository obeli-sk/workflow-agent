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
            socat
            nodejs_22
            just
            docker
          ];
          withObelisk = commonDeps ++ [ obelisk.packages.${system}.default ];
        in
        {
          devShells.noObelisk = pkgs.mkShell {
            nativeBuildInputs = commonDeps;
            shellHook = ''
              echo "obelisk-agent dev shell - node $(node --version)"
            '';
          };
          devShells.default = pkgs.mkShell {
            nativeBuildInputs = withObelisk;
            shellHook = ''
              echo "obelisk-agent dev shell - node $(node --version)  obelisk $(obelisk --version 2>/dev/null | head -1)"
            '';
          };
        }
      );
}
