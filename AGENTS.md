# Repository instructions

- Work directly on `main`. Do not create branches or pull requests unless the user explicitly asks for them.
- Keep deployment configuration and documentation pointed at `main`.
- Preserve the basic index / host / player game. Do not add databases, Admin, AWS integrations, or server backup/recovery unless explicitly requested.
- The authorized AWS deployment uses Amplify static Hosting and one AppSync Event API. Keep room state in the host tab's RAM, with no external Node hosting service, database, or account system.
- Amplify must build without GAME_SERVER_URL. Unconfigured AppSync builds show a setup notice and block gameplay; configured builds must use the encrypted AppSync transport.
- Run `npm test` for gameplay changes. Check deployment links and configuration when changing deployment documentation.
