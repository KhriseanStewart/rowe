# Rowe Platform

Rowe is a desktop AI workspace for working with local projects and connected repositories. It combines an Electron desktop application with a React interface and a retrieval-augmented generation (RAG) system.

Rowe can index project files, retrieve relevant source excerpts, and provide them to an AI model so responses are grounded in the project being reviewed. It is designed to help developers understand codebases, investigate implementation details, and work with project context through a conversational interface.

## Technology

- Electron
- React
- TypeScript
- Electron Vite
- PostgreSQL
- Firebase
- OpenRouter-compatible AI model access
- Retrieval-augmented generation (RAG)

## Requirements

Install the following before running Rowe:

- Node.js 18 or newer
- npm
- PostgreSQL for RAG features
- Firebase CLI for Firebase deployment
- Bun for the RAG test command

## Installation

Clone the repository and move into the project directory:

```bash
git clone <repository-url>
cd rowe
```

Install the project dependencies:

```bash
npm install
```

The installation process also downloads the native resources required by Electron, including `snip` and `koffi`.

## Run in Development

Start the Electron application in development mode:

```bash
npm run dev
```

To start the application using an existing production build:

```bash
npm run start
```

## PostgreSQL and RAG Setup

Rowe uses PostgreSQL to store indexed project content and retrieval metadata.

The default development connection expects PostgreSQL to be available at:

```text
127.0.0.1:5432
```

The default database name is:

```text
rowe
```

Check the database connection:

```bash
npm run rag:check
```

Apply the database migrations:

```bash
npm run rag:migrate
```

To use a custom PostgreSQL connection, set `RAG_DATABASE_URL`:

```bash
RAG_DATABASE_URL="postgresql://user:password@host:5432/database" npm run rag:migrate
```

Run the RAG tests:

```bash
npm run rag:test
```

## How the AI Workflow Works

Rowe's AI workflow has two primary stages.

### Project indexing

1. Rowe discovers supported files in a local project or connected repository.
2. Files are filtered to remove generated content, dependencies, and other excluded paths.
3. Source files are divided into searchable text chunks.
4. Each chunk is converted into an embedding.
5. The chunks, embeddings, file paths, and project metadata are stored in PostgreSQL.

### Question answering

1. A user asks a question in the Rowe interface.
2. The question is converted into an embedding.
3. Rowe searches the indexed project for semantically relevant chunks.
4. Relevant excerpts are assembled as context.
5. The context and user question are sent to the configured AI model.
6. The model generates a response grounded in the retrieved project files.

Responses should use the selected project as the primary source of truth. When the available project context does not establish an answer, the response should clearly state the uncertainty instead of inventing implementation details.

## Build the Application

Run the production build with type checking:

```bash
npm run build
```

Create an unpacked desktop build:

```bash
npm run build:unpack
```

Build a macOS application:

```bash
npm run build:mac
```

Build a Windows application:

```bash
npm run build:win
```

Build a Linux application:

```bash
npm run build:linux
```

## Development Commands

Run linting:

```bash
npm run lint
```

Format the source code:

```bash
npm run format
```

Run TypeScript checks:

```bash
npm run typecheck
```

Download the native dependencies manually when needed:

```bash
npm run download-snip
npm run download-koffi
```

## Firebase

Firebase configuration is included for the project's cloud functions and Firestore resources.

Deploy Firebase functions and configuration with:

```bash
npm run deploy:functions
```

Verify that the configured Firebase project and deployment credentials target the intended environment before deploying.

## Project Structure

```text
rowe/
├── src/
│   ├── main/                Electron main-process code
│   │   └── rag/             Indexing, retrieval, embeddings, and RAG logic
│   ├── preload/             Secure Electron-to-renderer bridge
│   └── renderer/            React user interface
├── functions/               Firebase Cloud Functions
├── migrations/              PostgreSQL and RAG database migrations
├── scripts/                 Development and native dependency scripts
├── docs/                    Technical documentation
├── resources/               Application resources
├── build/                   Desktop packaging configuration
├── package.json             Project dependencies and scripts
├── electron.vite.config.ts  Electron Vite configuration
├── electron-builder.yml     Electron packaging configuration
├── firebase.json             Firebase configuration
└── README.md                Project documentation
```

## Security

Do not commit API keys, database credentials, Firebase credentials, access tokens, or other secrets to the repository.

Use environment variables or secure operating-system credential storage for sensitive configuration. Review file filters and secret-redaction behavior before indexing repositories that may contain private source code, configuration, or user data.

Keep privileged operations and credentials in the Electron main process or other protected services. Do not expose secrets directly to the React renderer.

## Documentation

Additional information about the retrieval system and AI workflow is available in:

- [`docs/ai-process.md`](docs/ai-process.md)
- [`docs/rag-system.md`](docs/rag-system.md)
