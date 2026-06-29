# ClauseFinder Article Seed

ClauseFinder is a public acquisition research tool built for the messy first step of federal contracting work: turning a vague acquisition question into a short, source-linked list of likely FAR, DFARS, DAFFARS, eCFR, overhaul, and proposed-rule authorities.

The tool is designed around a sober premise. An acquisition staffer usually does not begin with a perfect citation. They begin with a question like, "What clause applies to safeguarding contractor information systems?" or "What changed about SAM registration under the FAR overhaul?" or "I have a $9,000 supply buy, what are my options?" ClauseFinder takes that plain-language question, asks clarifying questions when needed, searches public acquisition-rule sources, and returns candidate authorities with source links and caveats.

The key benefit is not replacing a contracting officer, policy attorney, or reviewer. The benefit is reducing the time and uncertainty between "I think this issue lives somewhere in FAR Part 4 or DFARS 204" and "Here are the most likely candidate clauses, prescriptions, source links, and reasons to verify them."

## What The Tool Searches

ClauseFinder indexes public acquisition sources that an Air Force acquisition staffer already has to work across manually:

- [FAR on Acquisition.gov](https://www.acquisition.gov/far), the government-wide acquisition regulation.
- [DFARS on Acquisition.gov](https://www.acquisition.gov/dfars), the Defense Federal Acquisition Regulation Supplement.
- [DAFFARS on Acquisition.gov](https://www.acquisition.gov/daffars), the Department of the Air Force supplement.
- [Revolutionary FAR Overhaul materials on Acquisition.gov](https://www.acquisition.gov/far-overhaul), where the current FAR rewrite effort and related source materials are published.
- [eCFR API data](https://www.ecfr.gov/developers/documentation/api/v1), including current Title 48 XML where available and historical version metadata.
- [Federal Register API data](https://www.federalregister.gov/developers/documentation/api/v1), especially proposed-rule metadata relevant to acquisition-rule changes.

The current build indexes 12,422 acquisition-rule nodes, including 4,815 current eCFR full-text nodes where the public Title 48 XML endpoint exposes the part. The repo is public at [github.com/wayanvota/clausefinder](https://github.com/wayanvota/clausefinder).

## Why This Matters For An Air Force Acquisition Staffer

Air Force acquisition staffers operate in a rule environment where the answer often depends on multiple layers at once. A clause question may start in the FAR, shift into DFARS because the acquisition is defense-related, and then require DAFFARS context because the buyer is working inside the Department of the Air Force. ClauseFinder is useful because it treats that layered reality as the default.

A staffer does not need to know the exact citation before searching. They can type a working question in ordinary language. If the question lacks facts that affect retrieval, the tool asks clarifying questions: acquisition type, commerciality, value band, competition status, funding layer, urgency, or contract stage. This matters because clause applicability often depends on facts, not only keywords.

For example, a query about "safeguarding contractor information systems" can surface FAR 52.204-21 and FAR 4.1903, but a defense or Air Force context also makes DFARS cybersecurity provisions worth checking. ClauseFinder does not tell the user, "Use this clause." It shows likely authorities, explains why they were retrieved, and points the user back to the source text.

That distinction is the tool's strongest editorial point. Many AI procurement demos imply that the hard part is generating an answer. ClauseFinder assumes the hard part is preserving traceability. Every result is framed as a candidate authority, not a compliance verdict.

## What The User Sees

A user starts at the ClauseFinder interface under `wayan.com/clause-finder/`. The first screen is the tool itself, not a marketing page. The staffer enters a question and can set context fields such as:

- acquisition type,
- commerciality,
- estimated value band,
- competition status,
- funding layer,
- urgency.

Before searching, the tool checks for sensitive-looking input. It warns against pasting CUI, source-selection material, proposal content, proprietary contractor information, or personal identifiers. This is especially relevant for acquisition staff because the most useful internal facts are often the facts that should not be pasted into a public or experimental system.

The user can then click "Start clause search." If the question is under-specified, ClauseFinder asks clarifying questions. The user can answer what they know or leave fields as "Not sure." Then the tool searches the index and returns ranked candidate authorities.

Each result includes:

- citation,
- title,
- source regime,
- source URL,
- score components,
- a plain-language relevance reason,
- a warning about why the result might not apply,
- extracted prescription text where available,
- cross references where available,
- current or historical source state where available.

There is also a grounded summary generated from retrieved candidates only. This summary is intentionally bounded. It is not allowed to invent authorities outside the retrieved result set. If the OpenAI API is unavailable, the tool still runs using deterministic search and fallback behavior.

## Why Citation-Aware Search Matters

A staffer often knows part of a citation but not the exact format. They may type "DFARS 252.204 7012" instead of "DFARS 252.204-7012." ClauseFinder normalizes citation patterns so direct citation lookups rise above ordinary keyword matches.

That is more important than it sounds. Traditional keyword search can over-rank a related clause simply because it mentions the target citation repeatedly. ClauseFinder treats direct citation intent as a separate signal. If the user asks for FAR 4.1903, it should return FAR 4.1903 first. If the user asks for DFARS 252.204-7012, it should return that provision or clause family first, not a nearby cybersecurity clause that happens to cite it.

For an acquisition staffer, that reduces one common source of friction: knowing enough to search, but not enough to trust the order of results.

## The Air Force Use Case

The natural user is an Air Force acquisition staffer who needs fast orientation before formal review. That could be a contracting specialist checking a clause issue, a program office staffer trying to understand why contracting is asking for a provision, a policy analyst tracking FAR overhaul effects, or a journalist or researcher trying to understand the public rule base.

In an Air Force setting, the tool's value is strongest in five moments:

1. **Early market or acquisition planning:** A user can ask which authorities may matter before writing or revising documents.
2. **Clause prescription research:** A user can search by issue and inspect the prescription language instead of hunting through unrelated search results.
3. **Supplement awareness:** The tool keeps FAR, DFARS, and DAFFARS in view so the staffer does not stop at the first government-wide answer.
4. **Overhaul tracking:** Because the tool indexes FAR Overhaul and Federal Register proposed-rule metadata, it can surface signals that a rule area may be in flux.
5. **Reviewer handoff:** The export function creates a JSON packet with the question, context, candidate citations, source URLs, scores, and reviewer notes. That makes the research trail easier to share or reconstruct.

The staffer still has to verify the answer. ClauseFinder simply makes the first pass faster, more explicit, and more auditable.

## What It Does Not Do

ClauseFinder does not decide compliance. It does not certify a clause set. It does not replace legal review, a warranted contracting officer, or agency policy interpretation. It also should not receive sensitive acquisition material.

That limitation is not a weakness. It is the product discipline that makes the tool more credible. The tool is designed to help a user find and inspect candidate authorities, not to issue confident procurement advice from a black box.

There are also technical limits. Current eCFR full text is indexed where the public Title 48 XML endpoint exposes a part. Historical eCFR coverage is still version metadata, not full historical text snapshots. Federal Register proposed-rule coverage uses available metadata and abstracts. FAR Overhaul deviation PDF and line-out extraction still need a stronger text pipeline before anyone should treat them as complete.

## Article Angle

ClauseFinder is a practical example of what acquisition AI should look like when it is built for public accountability instead of demo theater.

It does not ask users to trust an AI answer. It asks them to inspect the sources. It does not hide uncertainty. It marks it. It does not treat procurement rules as generic text. It recognizes that Air Force acquisition staff live inside layered rule systems: FAR, DFARS, DAFFARS, eCFR, Federal Register notices, and temporary overhaul materials.

The tool's promise is modest but useful: make the first 20 minutes of acquisition-rule research take closer to two minutes, while preserving source links, caveats, and human judgment. That is the right bar for AI in a rule-bound public function. Not autonomy. Not magic. Better orientation, faster triage, and a cleaner handoff to the people who remain accountable for the decision.
