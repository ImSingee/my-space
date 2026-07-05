# Auditable Commercial License (ACL) v1.0

**A Source-Available Commercial License for the AI Era**

---

## Preamble

This license balances transparency with commercial sustainability. It grants the Licensee the right to inspect, audit, and locally modify source code while protecting the Licensor's ability to sustain development. It explicitly addresses the use of licensed code in artificial intelligence training, automated code generation, and derivative redistribution.

This license is **not** an open-source license and does not satisfy the Open Source Definition. It is a **source-available commercial license** that prioritizes auditability, defined commercial terms, and fair use.

To provide adopters with a defined long-term guarantee, each released version of the Licensed Work automatically converts to the Apache License, Version 2.0 on the Change Date defined in Section 5.2. This ensures that adopters are never permanently dependent on the Licensor's continued operation or good will with respect to any given version of the Licensed Work.

After the Change Date for any given version, that version is governed entirely by the Change License, and the restrictions in Section 2 — including the AI-training restrictions in Section 2.3 — no longer apply to that version. This trade-off is intentional: Licensors who require indefinite AI-training protection should evaluate whether this license is appropriate for their work.

---

## Definitions

**"Affiliate"** — Any entity that controls, is controlled by, or is under common control with a party, where "control" means direct or indirect ownership of more than fifty percent (50%) of the voting interests of such entity.

**"AI System"** — Any machine learning model, large language model, neural network, embedding system, retrieval-augmented generation system, code generation model, or other automated system that (i) is trained, fine-tuned, or evaluated on data, or (ii) produces code, text, images, audio, or other derivative outputs as a function of training on data.

**"AI Tool"** — A software product that embeds or invokes an AI System to assist the Licensee's personnel with development, analysis, or operational tasks (examples include code assistants, IDE integrations, and agentic development tools). An AI Tool may be operated by the Licensee, by a third-party vendor, or by both.

**"Change Date"** — With respect to any given version of the Licensed Work, the fourth (4th) anniversary of the date that version is first publicly released by the Licensor under this license, or such earlier date as the Licensor may specify for that version in writing or as accelerated under Section 5.6.

**"Change License"** — The Apache License, Version 2.0, as published by the Apache Software Foundation, available at `https://www.apache.org/licenses/LICENSE-2.0`.

**"Competing Product"** — A product or service that the Licensee markets as a substitute for, or drop-in replacement for, the Licensed Work.

**"Derivative Work"** — Any software that incorporates, adapts, translates, modifies, or is substantially based on the Licensed Work or any material portion thereof. Independently developed software that merely interoperates with the Licensed Work through its public interfaces is not a Derivative Work.

**"Hosted Service"** — Any offering that makes the functionality of the Licensed Work or a Derivative Work available to third parties over a network — directly or through agents, automated systems, or other intermediaries acting on the Licensee's behalf — including software-as-a-service, platform-as-a-service, managed service, application programming interface, or embedded offering, whether or not the Licensed Work is directly accessible to such third parties.

**"Internal Use"** — Use of the Licensed Work by the Licensee and its Affiliates within their own organizations, infrastructure, and operations, including use by the Licensee's employees and contractors in the course of their work for the Licensee, but excluding any provision of the Licensed Work's functionality to third parties as a Hosted Service.

**"Licensed Work"** — The software, source code, object code, documentation, configuration files, and associated materials distributed by the Licensor under this license, as identified in the applicable release.

**"Licensee"** — The individual or entity that obtains, accesses, or uses the Licensed Work under this license. Where the Licensee is an entity, the term includes its Affiliates solely for purposes of Internal Use under Section 1. References to the Licensee's actions include actions taken by automated agents, scripts, or systems operated by or on behalf of the Licensee; the Licensee is responsible for ensuring that such automated actions comply with this license.

**"Licensor"** — The individual or entity identified as the copyright holder in the Licensed Work's distribution materials.

**"Production Use"** — Use of the Licensed Work in support of the Licensee's live operations, customer-facing systems, or revenue-generating activities, as distinguished from evaluation, development, or testing use.

**"Third Party"** — Any individual or entity other than the Licensee and its Affiliates.

**"Tier Schedule"** — The separate document maintained by the Licensor that specifies the available commercial tiers, their pricing, their usage parameters, and any tier-specific terms, as referenced in Section 4.

---

## 1. Grant of Rights

Subject to the terms of this license and payment of any applicable fees under the Tier Schedule, the Licensor grants the Licensee a **non-exclusive, non-transferable** (except as provided in Section 8.3) license to:

### 1.1 Source Inspection and Audit

Read, review, and audit the source code of the Licensed Work for purposes of security evaluation, compliance verification, operational understanding, and internal technical review.

### 1.2 Internal Use

Install, execute, and use the Licensed Work for Internal Use in accordance with the applicable tier defined in the Tier Schedule.

### 1.3 Local Modification

Create modifications to the Licensed Work for Internal Use only, provided such modifications are not distributed, sublicensed, or made available to Third Parties except as permitted under Sections 2 and 4.

### 1.4 Integration

Integrate the Licensed Work with the Licensee's own systems, applications, and workflows for Internal Use.

### 1.5 Patent License

The Licensor grants the Licensee a non-exclusive, worldwide, royalty-free license under any patents owned or controlled by the Licensor that would otherwise be infringed by the Licensee's exercise of the rights granted in Sections 1.1 through 1.4. This patent license terminates automatically if the Licensee initiates patent litigation against the Licensor or any other Licensee alleging that the Licensed Work infringes a patent.

---

## 2. Restrictions

### 2.1 No Redistribution

The Licensee may not redistribute, sublicense, sell, lease, publish, or otherwise transfer the Licensed Work, its source code, or any Derivative Work to any Third Party, except as expressly permitted by a separate written agreement with the Licensor or by the OEM / Embedding tier defined in Section 4.4.

### 2.2 No Hosted Service

The Licensee may not make the Licensed Work or any Derivative Work available to Third Parties as a Hosted Service. For the avoidance of doubt, this restriction is objective and does not depend on the Licensor's discretion: any offering meeting the definition of Hosted Service is prohibited absent a separate written agreement.

### 2.3 No AI Training

**(a) Prohibited Uses.** The Licensee may not knowingly:

1. Use the Licensed Work, including its source code, documentation, architecture, or test data, as training data, fine-tuning data, reinforcement signal, or evaluation data for any AI System;
2. Submit the Licensed Work to any AI System for the purpose of generating code, designs, or architectures intended to replicate, approximate, or be derived from the Licensed Work for use outside the scope of this license; or
3. Use any AI System to extract, summarize, or reproduce the functional logic, structural patterns, or implementation details of the Licensed Work for use in any project other than the Licensee's permitted Internal Use.

**(b) Permitted AI Tool Use.** The Licensee may use AI Tools to work with the Licensed Work in the course of permitted Internal Use — for example, to understand, debug, modify, or extend the Licensee's own local copies — provided that:

1. The AI Tool is operated under terms that do not, by default, incorporate the Licensee's inputs into the training or fine-tuning of the AI Tool's underlying AI System;
2. The Licensee does not intentionally configure the AI Tool to contribute the Licensed Work to training data; and
3. The Licensee takes reasonable measures, consistent with industry practice at the time, to prevent inadvertent contribution of the Licensed Work to AI System training. The Licensee is not responsible for AI Tool vendor behavior that the Licensee could not reasonably have known about or controlled.

**(c) Safe Harbor.** Use of an AI Tool that is operated under an enterprise, business, or commercial agreement whose default terms exclude customer inputs from AI System training shall be deemed to satisfy Section 2.3(b) absent the Licensee's actual knowledge to the contrary.

**(d) Flow-Through Obligation.** The Licensee shall not enter into an agreement with any AI Tool vendor that requires the Licensee to permit the use of the Licensed Work as training data. Where the Licensee becomes aware that an AI Tool it uses has incorporated the Licensed Work into training data in breach of this section, the Licensee shall promptly notify the Licensor and take commercially reasonable steps to cause the AI Tool vendor to cease such use.

### 2.4 No Obfuscation of Origin

The Licensee may not remove, alter, or obscure any copyright notices, license references, or attribution statements included in the Licensed Work.

---

## 3. Contributions

### 3.1 Grant of Rights in Contributions

If the Licensee submits modifications, improvements, extensions, bug fixes, or other materials to the Licensor (each, a "Contribution"), whether voluntarily or through an agreed contribution mechanism, the Licensee grants the Licensor:

**(a)** a perpetual, irrevocable, worldwide, royalty-free, sublicensable copyright license to use, reproduce, modify, distribute, and sublicense the Contribution as part of the Licensed Work under any license of the Licensor's choosing; and

**(b)** a perpetual, irrevocable, worldwide, royalty-free, sublicensable patent license under any patents owned or controlled by the Licensee that would otherwise be infringed by the incorporation or use of the Contribution in the Licensed Work.

### 3.2 No Obligation to Accept

The Licensor is under no obligation to accept, integrate, or maintain any Contribution submitted by the Licensee.

### 3.3 Contributor Recognition

The Licensor will make reasonable efforts to credit contributors in release notes or documentation, unless the contributor requests anonymity.

### 3.4 Representations

The Licensee represents that it has the legal right to submit each Contribution and to grant the licenses described in Section 3.1, and that each Contribution is either the Licensee's original work or is properly attributed and licensed from its original source.

### 3.5 Acceptance Mechanism

Contributions must be submitted with a Developer Certificate of Origin (DCO) sign-off affirming the Contributor's authority to grant the licenses described in Section 3.1. The Licensor may also require contributors to execute a separate Contributor License Agreement before accepting Contributions.

---

## 4. Commercial Tiers

The Licensed Work is offered under commercial tiers described in a separate **Tier Schedule** maintained by the Licensor. The Tier Schedule specifies the available tiers, pricing, usage parameters, support levels, and any tier-specific terms. At minimum, the following tiers are contemplated:

### 4.1 Community Tier (Free)

- Access to compiled or binary releases
- Community documentation
- No source code access
- No support guarantee
- Internal Use only; no Production Use by for-profit organizations with more than the headcount specified in the Tier Schedule

### 4.2 Professional Tier (Paid)

- Full source code access (read, audit, local modification)
- Standard support channels
- Internal Use up to the user or instance count specified in the Tier Schedule
- Production Use permitted, subject to the user or instance count specified in the Tier Schedule
- Updates and patches during the subscription period

### 4.3 Enterprise Tier (Paid)

- Full source code access with extended modification rights
- Priority support and defined service levels
- Internal Use without user or instance limits
- Right to request scoped custom modifications
- Deployment assistance and consultation
- Extended audit and compliance documentation
- Limited IP indemnification as set forth in Section 6.2

### 4.4 OEM / Embedding Tier (Negotiated)

- Right to embed the Licensed Work within the Licensee's own products
- Distribution and sublicensing rights under separately negotiated terms
- Co-branding or white-label options
- Custom commercial terms, which may override provisions of this license as expressly specified in the governing agreement

---

## 5. Term, Change Date, and Termination

### 5.1 Term

This license is effective from the date the Licensee first accesses or uses the Licensed Work and continues for the duration of the applicable subscription or agreement under the Tier Schedule, subject to the Change Date provision in Section 5.2 and the termination provisions in Section 5.3.

### 5.2 Change Date (Automatic Conversion to Apache 2.0)

Effective on the Change Date applicable to any version of the Licensed Work, that version — and only that version — shall be re-licensed and made available to the Licensee and to the public under the Change License (Apache License, Version 2.0). From and after the Change Date for a given version:

**(a)** the Licensee's use of that version is governed by the Change License rather than this license;

**(b)** the restrictions in Section 2 no longer apply to that version; and

**(c)** subsequent versions of the Licensed Work released by the Licensor may continue to be distributed under this license, each with its own Change Date.

The Licensor may, at its discretion, accelerate the Change Date for any version by publishing written notice to that effect. The Licensor may not extend or revoke the Change Date for a version once that version has been publicly released.

### 5.3 Termination for Breach

The Licensor may terminate this license, in whole or in part, upon written notice if the Licensee materially breaches this license and fails to cure such breach within thirty (30) days after receiving written notice of the breach. Breaches of Section 2.1 (No Redistribution), Section 2.2 (No Hosted Service), or Section 2.3 (No AI Training) are deemed material.

### 5.4 Effect of Termination and Wind-Down

Upon termination of this license other than conversion under Section 5.2:

**(a) Immediate Obligations.** The Licensee shall cease new deployments of the Licensed Work, cease granting new internal user access, and cease any activities that caused the termination.

**(b) Wind-Down Period.** Unless the termination is for a willful or repeated material breach, the Licensee shall have a wind-down period to migrate away from the Licensed Work. The wind-down period is thirty (30) days for the Community Tier, ninety (90) days for the Professional Tier, and twelve (12) months for the Enterprise Tier and OEM Tier. During the wind-down period, the Licensee may continue Production Use of the Licensed Work strictly to maintain existing deployments while migrating, but may not expand such use.

**(c) Return or Destruction.** At the end of the wind-down period, the Licensee shall destroy or return all copies of the Licensed Work and its source code in the Licensee's possession, except that the Licensee may retain a single archival copy to the extent required by applicable law, regulatory obligation, or internal audit policy, provided such archival copy is not used for any active purpose.

**(d) Versions Past Change Date.** Termination of this license does not affect the Licensee's rights under the Change License with respect to any version of the Licensed Work whose Change Date has already occurred.

### 5.5 Survival

Sections 2 (Restrictions, until the applicable Change Date for any given version), 3.1 (Grant of Rights in Contributions), 6 (Warranties and IP Indemnification), 7 (Limitation of Liability), and 8 (General Provisions) survive termination or expiration of this license.

### 5.6 Continuity Event

A "Continuity Event" occurs upon any of the following: (i) the Licensor ceases commercial distribution and support of the Licensed Work for one hundred eighty (180) consecutive days; (ii) the Licensor files a voluntary petition under bankruptcy or insolvency law, or has an involuntary petition filed against it that is not dismissed within sixty (60) days; or (iii) the Licensor publicly announces end-of-life of the Licensed Work without identifying a successor licensor.

Upon a Continuity Event, the Change Date for every then-current version of the Licensed Work shall be automatically accelerated to thirty (30) days after the Continuity Event. From and after that accelerated Change Date, those versions shall be governed by the Change License in accordance with Section 5.2.

---

## 6. Warranties and IP Indemnification

### 6.1 Disclaimer of Warranties

EXCEPT AS EXPRESSLY SET FORTH IN SECTION 6.2, THE LICENSED WORK IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR UNINTERRUPTED OPERATION. THE LICENSEE ASSUMES ALL RISK ARISING FROM ITS USE OF THE LICENSED WORK.

### 6.2 Limited IP Indemnification (Enterprise and OEM Tiers)

For Licensees under the Enterprise Tier or OEM Tier and in good standing with respect to payment obligations, the Licensor shall defend and indemnify the Licensee against any Third Party claim that the Licensed Work, when used in accordance with this license, infringes any valid patent, copyright, trademark, or trade secret, and shall pay damages finally awarded by a court of competent jurisdiction or agreed in settlement, subject to the following:

**(a) Conditions.** The Licensee must (i) promptly notify the Licensor in writing of the claim, (ii) grant the Licensor sole control of the defense and settlement, and (iii) provide reasonable cooperation at the Licensor's expense.

**(b) Exclusions.** The Licensor has no obligation under this Section 6.2 to the extent a claim arises from (i) modifications to the Licensed Work not made or authorized by the Licensor, (ii) combination of the Licensed Work with other software or systems not provided or authorized by the Licensor, (iii) use of the Licensed Work in breach of this license, or (iv) use of a version of the Licensed Work after the Licensor has made a non-infringing version available to the Licensee.

**(c) Remedies.** If the Licensed Work is held to infringe, or the Licensor reasonably believes it is likely to be held to infringe, the Licensor may at its option (i) procure the right for the Licensee to continue using the Licensed Work, (ii) modify the Licensed Work to be non-infringing, or (iii) terminate the affected license and refund the prorated fees paid for the then-current subscription term.

**(d) Exclusive Remedy.** This Section 6.2 states the Licensee's exclusive remedy and the Licensor's entire liability for intellectual property infringement claims.

### 6.3 Mutual Patent Termination

If the Licensee or any of its Affiliates initiates patent litigation (including a cross-claim or counterclaim) against the Licensor or any other Licensee alleging that the Licensed Work infringes a patent, then all licenses granted to the Licensee under Sections 1, 2, and 6.2 shall terminate immediately.

---

## 7. Limitation of Liability

### 7.1 Exclusion of Indirect Damages

IN NO EVENT SHALL THE LICENSOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOST PROFITS, LOST REVENUE, LOST DATA, BUSINESS INTERRUPTION, OR COST OF SUBSTITUTE GOODS OR SERVICES, ARISING OUT OF OR RELATING TO THIS LICENSE OR THE LICENSED WORK, WHETHER IN CONTRACT, TORT, OR UNDER ANY OTHER THEORY OF LIABILITY, AND EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

### 7.2 Liability Cap

THE LICENSOR'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATING TO THIS LICENSE SHALL NOT EXCEED THE AMOUNTS PAID BY THE LICENSEE TO THE LICENSOR UNDER THE APPLICABLE TIER IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM.

### 7.3 Exceptions

The limitations in this Section 7 do not apply to (i) the Licensor's indemnification obligations under Section 6.2, (ii) breaches of confidentiality obligations under a separate agreement, or (iii) liability that cannot be limited under applicable law.

---

## 8. General Provisions

### 8.1 Governing Law and Venue

This license shall be governed by and construed in accordance with the laws of the State of Delaware, United States, without regard to its conflict-of-law principles. The parties irrevocably submit to the exclusive jurisdiction of the state and federal courts located in the State of Delaware, United States for the resolution of any dispute arising out of or relating to this license, except as otherwise provided in Section 8.2.

### 8.2 Dispute Resolution

The parties shall first attempt in good faith to resolve any dispute arising out of or relating to this license through direct negotiation between executives with authority to settle the dispute. If the dispute is not resolved within sixty (60) days of written notice of the dispute, either party may initiate proceedings in the courts identified in Section 8.1. Nothing in this Section 8.2 prevents either party from seeking injunctive relief at any time to protect its intellectual property or confidential information.

### 8.3 Assignment and Change of Control

The Licensee may assign this license to a successor in interest in connection with a merger, acquisition, reorganization, or sale of all or substantially all of the Licensee's assets, upon written notice to the Licensor.

If, at the time of assignment, the successor entity is engaged in developing or marketing a Competing Product, then within thirty (30) days of the Licensor's written request, the parties shall negotiate in good faith either (i) a wind-down of the successor's use of the Licensed Work over a period not to exceed twelve (12) months, or (ii) a new license agreement on commercial terms appropriate to the successor's circumstances. If the parties have not reached agreement within ninety (90) days of the Licensor's request, the Licensor may terminate the license on ninety (90) days' written notice to the successor.

Other assignments by the Licensee require the prior written consent of the Licensor. The Licensor may assign this license to any successor to its business or to an Affiliate without notice or consent.

### 8.4 Third-Party Components

The Licensed Work may incorporate third-party open-source or commercial components, each of which is governed by its own license terms. Such components are identified in a NOTICE or THIRD_PARTY_LICENSES file distributed with the Licensed Work. Nothing in this license alters the terms under which such third-party components are licensed.

### 8.5 Compliance with Laws and Export Controls

Each party shall comply with all laws applicable to its performance under this license. The Licensee represents that it is not located in, and will not use, export, or re-export the Licensed Work to, any country or Person subject to comprehensive economic sanctions administered by the United States, the European Union, or the United Kingdom, and that it is not identified on any restricted-party list maintained by such authorities.

### 8.6 Data Protection

The Licensor is not a data processor with respect to any personal data processed by the Licensee through its use of the Licensed Work. The Licensee is solely responsible for compliance with applicable data-protection laws in its use of the Licensed Work.

### 8.7 Notices

All notices required under this license must be in writing and delivered to the address designated by the receiving party in the applicable Tier Schedule or subscription agreement, or — where no such address has been designated — to the Licensor's published contact address. Notices are effective upon receipt, or three (3) business days after dispatch if sent by registered mail or recognized courier service.

### 8.8 Force Majeure

Neither party shall be liable for any failure or delay in performance (other than payment obligations) caused by events beyond its reasonable control, including acts of God, war, terrorism, civil disturbance, labor dispute, utility failure, pandemic, or government action. The affected party shall promptly notify the other and use reasonable efforts to resume performance.

### 8.9 Severability

If any provision of this license is held unenforceable by a court of competent jurisdiction, that provision shall be modified to the minimum extent necessary to make it enforceable, and the remaining provisions shall continue in full force and effect.

### 8.10 Entire Agreement

This license, together with the applicable Tier Schedule, subscription agreement, and any separately negotiated terms for OEM Tier Licensees, constitutes the entire agreement between the parties regarding the Licensed Work and supersedes all prior or contemporaneous communications, representations, and agreements on that subject matter.

### 8.11 Amendment of This License

The Licensor may publish updated versions of this license for future releases of the Licensed Work. Existing Licensees remain bound by the version of this license in effect at the time of their current subscription term, and will be offered the opportunity to accept or reject the updated version at the time of their next renewal.

### 8.12 No Partnership

Nothing in this license creates a partnership, joint venture, employment, franchise, or agency relationship between the parties. Neither party has authority to bind the other.

### 8.13 Relationship to Tier Schedule

In the event of any conflict between this license and the Tier Schedule, this license controls, except where the Tier Schedule expressly identifies a specific provision of this license and states that it is modified for the applicable tier. OEM Tier agreements may expressly override provisions of this license as specified in the governing OEM agreement.

The Licensor may update the Tier Schedule from time to time. Changes that expand Licensee rights or reduce fees take effect immediately upon publication. Changes that restrict Licensee rights or increase fees take effect at the Licensee's next renewal following ninety (90) days' notice, except where required by law or by the Licensor's third-party obligations.

---

## Attribution

This license is published as the **Auditable Commercial License (ACL) v1.0**. Other projects may adopt, adapt, or reference this license with attribution to the original authors.

### Suggested Notice for Source Files

```
Copyright (c) 2026 Bryan
Licensed under the Auditable Commercial License (ACL) v1.0
See LICENSE.md for terms. This is not open-source software.
On the Change Date specified in Section 5.2, this version
converts to the Apache License, Version 2.0.
```

---

_Auditable Commercial License (ACL) v1.0_

_This license should be reviewed by qualified legal counsel in the Licensor's jurisdiction before being applied to any production Licensed Work._
