# Lindra

AI-powered browser agent system using Playwright. Includes our first open-source agent, achieving a preliminary 88.0% score in WebVoyager (#3 globally).

## Installation

```bash
npm install
npx playwright install --only-shell chromium
```

## Usage

```typescript
const task = {
  initialURL: "https://example.com",
  instructions: "Find the main heading text on the page",
  secrets: {},
  jsonOutputSchema: z.object({
    heading: z.string(),
  }),
  csvOutputSchemas: {},
};
const result = await main(task, defaultConfig);
console.log(result);
```

## Configuration

For the simplest setup, just set your Google API key:

```bash
export GEMINI_API_KEY=your_api_key
```
