# Market Scanner — Context Module

**Framework:** Bernhardt three-step (Demand → Competition → Positioning)
**Primary data source:** Apify Amazon scrapers
**Secondary:** Firecrawl Cloud `/interact` for discovery

---

## Apify Actor Reference (CORRECT Input Formats)

### 1. Amazon Search Scraper
**Actor:** `axesso_data~amazon-search-scraper`

```bash
curl -X POST "https://api.apify.com/v2/acts/axesso_data~amazon-search-scraper/runs?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": [{"keyword": "...", "domainCode": "com", "sortBy": "relevant", "maxPages": 3, "category": "stripbooks"}]}'
```

- `domainCode`: `"com"` (US), `"co.uk"` (UK), `"co.de"` (DE), etc.
- Results may omit BSR — use review count + price as proxy if needed.

### 2. Amazon Product Details Scraper
**Actor:** `axesso_data~amazon-product-details-scraper`

```bash
curl -X POST "https://api.apify.com/v2/acts/axesso_data~amazon-product-details-scraper/runs?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://www.amazon.com/dp/ASIN1", "https://www.amazon.com/dp/ASIN2"]}'
```

> **IMPORTANT:** Input key is `"urls"` (array of strings), NOT `"input": [{"url": "..."}]`. The wrong format silently fails.

Use this scraper to get BSR and publication dates for the top 10 results from the search scraper.

### Credit Budget Awareness
- Search scraper: ~$0.50–$1.00 per run (3 pages, stripbooks)
- Product details: ~$0.10–$0.20 per 10 ASINs
- Typical full scan (US + UK, 3 keywords, top 10 product details): ~$4–$8 total

---

## Firecrawl Cloud API — `/interact` Pattern

Use for exploratory discovery: reading Amazon bestseller lists, checking category pages, verifying BSR rank positions.

```bash
curl -X POST "https://api.firecrawl.dev/v1/interact" \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.amazon.com/Best-Sellers-Books/zgbs/books/...", "actions": [{"type": "scrape"}]}'
```

Credit cost: ~$0.10–$0.30 per minute of crawl time. Keep interactions targeted.

---

## Step 1: Demand Analysis (Bernhardt Thresholds)

Run search scraper for primary keyword + 2–3 adjacent keywords on US (and UK if British-audience niche).

**BSR thresholds (US market):**
- ≥1 book under 30,000 BSR = minimum viable demand
- 3–5 books under 60,000 BSR = healthy demand
- 20+ books under 30k AND 50+ under 60k = high saturation

**UK BSR thresholds** (lower absolute numbers — smaller market):
- ≥1 book under 10,000 BSR = minimum viable demand
- 3–5 books under 30,000 BSR = healthy demand

**Pub date filter (Bernhardt rule):** Exclude books published within the last 3 months from BSR threshold assessment. These may be artificially boosted by ad spend. The search scraper does NOT return publication dates — use the product details scraper to check pub dates for the top results before counting them toward thresholds.

**Primary market heuristic:**
- British-audience niche (UK culture, UK slang, UK-specific content): weight UK BSR more heavily; UK is primary market.
- All other niches: US is primary market; UK is supplementary validation.

---

## Step 2: Competition Analysis

For the top 10 results by relevance/review count, score each on 9 dimensions:

| Dimension | Attack point | Defence |
|---|---|---|
| Reviews | <50, or rating <4.0 | 200+ at 4.5+ stars |
| Cover | Dated, amateur | Professional, eye-catching |
| Title | Keyword-stuffed, generic | Concept-driven, memorable |
| Description | Thin, unformatted | Compelling + social proof |
| A+ content | Missing | Rich modules |
| Formats | Single format | Ebook + PB + HC |
| Pricing | Off sweet-spot | Sweet-spot, good royalty |
| Branding | One-off | Series, cross-promotion |
| Pub date | 5+ years old | Recent or updated |

**Attack:Defence ratio > 2:1 = strong opportunity.**

---

## Step 3: Positioning Assessment

Assess:
1. What Blue Ocean angle is available?
2. Does the "sell first" model work here (can it convert without reviews)?
3. Tier assignment (see below).

---

## Tiered Launch Model

| Market Scanner signal | Tier | Action |
|---|---|---|
| Marginal demand + zero competition | **Tier 1** | Organic-only, no ads |
| Marginal demand + some competition | **Skip** | Not enough demand to compete |
| Healthy demand + weak competition | **Tier 2** | Full "sell first" launch, ads from day 1 |
| Healthy demand + strong competition | **Tier 2 or 3** | Only if positioning is exceptional |
| Strong demand + heavy competition | **Tier 3** | Only with external traffic + resources |
| No demand | **Skip** | Move on |

**Tier 1** — Category-of-one. Review dependency: LOW. Revenue: $50–150/month passive.
**Tier 2** — Positioned gap. Review dependency: HIGH (need 5+ before ad scale). Revenue: $200–1,000/month.
**Tier 3** — Market creation. Review dependency: CRITICAL (20+ within 30 days). Revenue: $500–5,000/month if successful.

**Viability score → tier:**
- 70+ with healthy demand → Tier 2 or 3
- 55–69 with weak competition → Tier 1 or 2
- 40–54, marginal demand, no competition → Tier 1
- <40 → Skip

---

## Output Format Template

```
## Market Scanner Report: {Niche Name}

**Market:** US + UK (or US only)
**Date:** {date}
**Apify credits used:** {estimate}

### 1. Demand Analysis
{BSR/review data, threshold assessment, pub-date-filtered count, seasonality notes}

### 2. Competition Analysis
{Top 10 competitor profiles with attack/defence scoring}
{Competition ratio: X attack : Y defence}

### 3. Positioning Assessment
{Positioning angle, Blue Ocean test, tier assignment}

### 4. Viability Score
{Score 1–100 with breakdown across 6 factors}

### 5. Verdict
{Go / Conditional Go / Revise / Skip}
{Tier assignment: 1, 2, or 3}
{Specific next steps}
```

---

## Known Quirks

1. **UK BSR format:** UK Amazon returns BSR without the `#` prefix. Parse `993 in Books` (UK) and `#993 in Books` (US) as equivalent. Normalise before applying thresholds.

2. **Pub date filter:** The search scraper does not return publication dates. Always call the product details scraper for the top 10 ASINs to get pub dates before finalising demand counts.

3. **BSR missing from search results:** The search scraper sometimes omits BSR. When missing, use review count + price as proxy signals, and note the gap in the report. Fetch product details for top results to get confirmed BSR.

4. **External traffic trap:** A single dominant book driven by social media or a platform author can make a niche look healthier than it is. Flag if one book accounts for >50% of the visible demand signal.

5. **Primary market for British niches:** UK BSR thresholds should be weighted more heavily for British-audience niches. US BSR data is still valuable as supplementary signal.
