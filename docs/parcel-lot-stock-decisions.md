# Parcel and lot stock: decisions and questions for the repo owner

**Status:** waiting for answers. Nothing is built.
**Date:** 10 November 2026
**Full design:** [parcel-lot-stock-design.md](parcel-lot-stock-design.md). Section numbers below refer to it.

This page lists what needs a decision before the build starts. Write the answer under each item and commit the file. "Agreed" is enough where the recommendation stands.

## Decisions

### 1. Where piece counts, stone attributes, lineage and custody live

- **Recommendation:** in Berpal's own database. ERPNext holds carats and money only.
- **Alternative:** custom fields inside ERPNext. That needs a custom ERPNext app on every site, which changes between ERPNext versions and raises a licensing question (ERPNext is GPL).
- **Detail:** section 5.

**Answer:**

### 2. How lot tracking is switched on

- **Recommendation:** a per-user niche setting (`gems`). Existing coded stones keep working. No migration of old stock.
- **Alternative:** on for everyone, which puts carat questions in front of users who do not trade stones.
- **Detail:** section 9.

**Answer:**

### 3. How lots map to ERPNext items

- **Recommendation:** two items per company, "rough" and "cut", measured in carats. Each lot is a Batch of one of them. The cost: ERPNext's own reports cannot break stock down by species; Berpal's can.
- **Alternative:** one item per species or per stone, which multiplies items for no accounting benefit.
- **Detail:** section 5.

**Answer:**

### 4. How contract cutting is booked

- **Recommendation:** a transfer out, then a "came back cut" entry that adds the cutter's fee to the cost of the cut stones.
- **Alternative:** ERPNext Subcontracting, which needs a bill of materials, a service item, a purchase order and two more documents per job.
- **Detail:** sections 5 and 6.

**Answer:**

### 5. When the cutter's fee must be known

- **Recommendation:** when the stones come back, in the same message. Late fees are a later feature.
- **Alternative:** allow late fees from day one. ERPNext v14 and v15 cannot add cost to a stock entry afterwards; the workaround is unproven.
- **Detail:** section 6, rule 7.

**Answer:**

### 6. How cost is shared when a lot is sorted into grades

- **Recommendation:** one method per user, chosen once: by the value the trader puts on each grade (recommended default), or by weight.
- **Alternative:** choose per sort, which conflicts with the Revenue Department's expectation of one consistent valuation method. Always by weight is simpler but misstates profit.
- **Detail:** section 6, rules 2 to 4 and the worked example.

**Answer:**

### 7. How custody appears in ERPNext

- **Recommendation:** three warehouses per company (in hand, out for work, out on memo). Who holds each lot is kept in Berpal. A lot is in one place with one holder at a time.
- **Alternative:** one warehouse per cutter and broker, which multiplies warehouses with every new contact.
- **Detail:** sections 4 and 5.

**Answer:**

### 8. Build order

- **Recommendation:** a proof on a real ERPNext first, then four phases: lots in and out; sorting and cutting; custody and memo; tax and paperwork.
- **Alternative:** build against the test double only. Several ERPNext behaviours here are too important to assume.
- **Detail:** section 12.

**Answer:**

## Questions

### Q1. Traders to learn from

Can one or two traders walk us through their real books and memo slips? No published source describes how small Thai traders keep records, so the card wording, the check thresholds (section 8) and the default memo period are educated guesses until someone shows us.

**Answer:**

### Q2. Numbering

How do the target users number parcels and stones today? The design accepts their own codes and otherwise assigns `L` plus a number.

**Answer:**

### Q3. Tax profile of the first users

Individual, registered dealer using the Royal Decree 311 exemption, or VAT-registered without it? This decides whether the tax phase is urgent or can wait.

**Answer:**

### Q4. Accountant

Is a Thai accountant available to check section 11 and the cost-sharing method in decision 6? These points are unconfirmed:

- the three-way tax profile itself (our own reading of translated Revenue Department pages);
- the withholding rate on uncut stones bought from individuals (1% is documented only for 2013 and 2014);
- whether the anti-money-laundering reporting thresholds apply to sole traders;
- whether Royal Decrees 617 and 618 are still in force.

**Answer:**

### Q5. Default cost-sharing method

For decision 6: should "by value" be the default for new gem users with "by weight" as the opt-out, or the other way round?

**Answer:**

### Q6. VAT rate, affects today's code

The 7% VAT extension the research found ran to 30 September 2026. What is the rate now? This affects the VAT code already on this branch, not only the lot design.

**Answer:**

### Q7. ERPNext for the proof

Phase 0 and the pending smoke test both need a live ERPNext v14 site. Whoever holds the credentials adds `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` and `ERPNEXT_COMPANY_DEFAULT` to the local `.env` (never to git, never in chat). Is a site available, and is it v14 or v15?

**Answer:**
