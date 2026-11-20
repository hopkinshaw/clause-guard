import type { Analysis } from "./analysis";

export const demoContract = `INDEPENDENT CONTRACTOR AGREEMENT
Client: Orbit Labs, Inc. | Contractor: Independent Designer
Scope: Brand identity and launch website design. Fee: $2,400 fixed.

1. PAYMENT. Payment is due within 90 days of Client's final approval. Client may withhold payment if deliverables do not meet its satisfaction.
2. INTELLECTUAL PROPERTY. All work product, source files, pre-existing tools, templates, and concepts created or used by Contractor shall become the exclusive property of Client upon creation, whether or not payment has been made.
3. REVISIONS. Contractor shall provide unlimited revisions and additional design requests at no additional charge until Client is fully satisfied.
4. LIABILITY. Contractor shall indemnify Client against all claims, losses, and expenses arising from the project, without limitation of liability.
5. TERMINATION. Client may terminate this agreement at any time. No payment is owed for incomplete or unapproved work.
6. CONFIDENTIALITY. Contractor shall keep non-public Client information confidential for two years.`;

export const demoAnalysis: Analysis = {
  riskLevel: "HIGH",
  summary: "You could give away your tools, work through endless revisions, and still walk away unpaid.",
  redFlags: [
    { clauseTitle: "Your IP transfers before you get paid", quote: "All work product, source files, pre-existing tools, templates, and concepts created or used by Contractor shall become the exclusive property of Client upon creation, whether or not payment has been made.", plainEnglish: "They own the work immediately—even if they never pay. This also hands over the templates and tools you use for other clients.", suggestedRedline: "Ownership of final, approved deliverables transfers only upon receipt of full payment. Contractor retains all pre-existing tools, templates, concepts, and working files. Client receives a perpetual license to any background materials embedded in the final deliverables." },
    { clauseTitle: "A payment date that keeps moving", quote: "Payment is due within 90 days of Client's final approval. Client may withhold payment if deliverables do not meet its satisfaction.", plainEnglish: "The 90-day clock only starts when they approve. With no approval deadline or objective criteria, you could be waiting indefinitely.", suggestedRedline: "Client pays 50% before work begins and 50% within 14 days of final delivery. Deliverables are deemed accepted unless Client identifies specific deviations from the agreed scope within 7 business days." },
    { clauseTitle: "Unlimited revisions. Limited income.", quote: "Contractor shall provide unlimited revisions and additional design requests at no additional charge until Client is fully satisfied.", plainEnglish: "A fixed-price project can become an endless retainer. Every extra request eats into your effective hourly rate.", suggestedRedline: "The fee includes two consolidated revision rounds within the agreed scope. Additional rounds or scope changes require a written estimate and Client approval before work begins." },
    { clauseTitle: "All the liability lands on you", quote: "Contractor shall indemnify Client against all claims, losses, and expenses arising from the project, without limitation of liability.", plainEnglish: "A $2,400 project could expose you to losses far beyond your fee, including claims you did not cause.", suggestedRedline: "Each party is responsible for third-party claims caused by its own negligence or willful misconduct. To the extent permitted by applicable law, aggregate liability is capped at fees paid under this agreement, and neither party is liable for indirect or consequential damages." },
    { clauseTitle: "They can cancel and pay nothing", quote: "Client may terminate this agreement at any time. No payment is owed for incomplete or unapproved work.", plainEnglish: "They can pull the plug just before approval and leave you covering all the time already invested.", suggestedRedline: "Either party may terminate on 7 days' written notice. Client shall pay for work performed and approved non-cancellable expenses through termination, with the initial deposit credited toward the amount due." },
  ],
  emailReplies: {
    politeNegotiation: "Hi there,\n\nThanks for sending the agreement—I’m excited to get started. Before signing, I’d like to align a few terms: ownership of final deliverables should transfer after full payment, with my existing tools and templates excluded; payment should be due within 14 days of delivery; and the scope should include two revision rounds.\n\nI’d also like to cap liability at the project fee and ensure work completed is paid for if the project is cancelled. Happy to send over suggested wording so we can keep things moving.\n\nBest regards",
    upsellPricing: "Hi there,\n\nThe $2,400 quote covers the agreed final deliverables. A broader IP buyout and handover of editable source files would expand the scope and require an additional fee, which I can quote once we agree on the assets and usage rights you need. My pre-existing tools and templates would remain excluded.\n\nLet me know your preferred option, and I’ll send an updated estimate and agreement.\n\nBest regards",
    firmDecline: "Hi there,\n\nThank you for considering me for this project. After reviewing the agreement, I’m unable to proceed with the current payment, ownership, revision, and liability terms. They create a level of commercial exposure I can’t take on at this project fee.\n\nIf there’s room to revisit those terms, I’d be happy to reconnect. Otherwise, I wish you every success with the project.\n\nBest regards",
  },
};
