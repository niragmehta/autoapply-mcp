# Third-party notices

autoapply-mcp is MIT licensed (see LICENSE). It builds on the work below.

## career-ops

Several job-source adapters, the posting-liveness and legitimacy checks, and the
evaluation, interview, outreach and offer workflows were designed after studying
[career-ops](https://github.com/career-ops-hq/career-ops). Source files that adapt
its endpoint behaviour or logic say so in a header comment. Its license applies to
those portions:

```
MIT License

Copyright (c) 2026 Santiago Fernández de Valderrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime libraries

| Package | License | Used for |
|---|---|---|
| @modelcontextprotocol/sdk | MIT | MCP server |
| zod | MIT | Schema validation |
| fast-xml-parser | MIT | XML feeds |
| preact, htm | MIT | Dashboard UI |
| playwright (optional) | Apache-2.0 | Form filling, PDF rendering |
| imapflow (optional) | MIT | Reading verification codes and replies |
| pdfjs-dist (development) | Apache-2.0 | Verifying generated PDFs |

Fonts are not bundled. The resume template can embed Latin Modern, distributed
under the GUST Font License, from the user's own fonts directory.
