{
  description = "VS Code extension dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_20
            nodePackages.yo
            git
          ];

          shellHook = ''
            # Put npm "global" installs into the project dir (not /nix/store)
            export npm_config_prefix="$PWD/.npm-global"
            export PATH="$npm_config_prefix/bin:$PATH"

            echo "Run: npm i -g generator-code (installs into ./.npm-global)"
          '';
        };
      }
    );
}
