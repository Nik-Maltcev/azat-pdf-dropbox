# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## PDF Renamer Service

### Purpose
Reads PDF files from a Dropbox folder (`/Walterscheid`), extracts three fields from each PDF (customer name, customer drawing number, order number), and renames the files in Dropbox using the pattern: `{Customer}_{DrawingNo}_{OrderNo}.pdf`.

### Architecture
- **Backend**: Express API in `artifacts/api-server/src/routes/dropbox.ts`
  - `GET /api/dropbox/list` — lists PDFs, downloads and parses each, returns extracted fields + proposed new name
  - `POST /api/dropbox/rename` — renames selected files directly in Dropbox via `filesMove`
- **Frontend**: React + Vite app in `artifacts/pdf-renamer/` at `/`
  - Shows file list with original name, extracted fields, proposed new name
  - Checkboxes to select/deselect files before renaming
  - Status badges: Ready / Unresolved / Error / Renamed
- **Libraries**: `dropbox` (Dropbox API), `pdf-parse` (PDF text extraction, externalized in esbuild)
- **Auth**: Dropbox Access Token stored as `DROPBOX_ACCESS_TOKEN` secret

### Dropbox Integration Note

The Dropbox OAuth integration was dismissed by the user. Instead, the app uses a Dropbox Access Token stored as a secret (`DROPBOX_ACCESS_TOKEN`). If this stops working in the future, try the Replit Dropbox connector (`connector:ccfg_dropbox_01K49RKF1K3H5YEV4A3QXW28XT`) instead.
