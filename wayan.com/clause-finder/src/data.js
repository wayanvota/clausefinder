export const contextDefaults = {
  acquisitionType: "Not sure",
  commerciality: "Not sure",
  valueBand: "Not sure",
  competition: "Not sure",
  fundingLayer: "Air Force",
  urgency: "Normal"
};

export const contextOptions = {
  acquisitionType: ["Not sure", "Supply", "Service", "Construction", "R&D", "Other"],
  commerciality: ["Not sure", "Commercial", "Noncommercial"],
  valueBand: [
    "Not sure",
    "At or near micro-purchase",
    "Below simplified acquisition",
    "Above simplified acquisition threshold",
    "Above $5M"
  ],
  competition: ["Not sure", "Full and open", "Set-aside", "Sole source"],
  fundingLayer: ["Air Force", "DoD", "Assisted acquisition", "Not sure"],
  urgency: ["Normal", "Urgent", "Emergency", "Not sure"]
};

export const examples = [
  {
    id: "sam-overhaul",
    label: "SAM change",
    question: "What changed about SAM registration under the FAR overhaul?",
    context: {
      acquisitionType: "Service",
      commerciality: "Commercial",
      valueBand: "Above simplified acquisition threshold",
      competition: "Full and open",
      fundingLayer: "Air Force",
      urgency: "Normal"
    }
  },
  {
    id: "supply-9000",
    label: "$9,000 supply buy",
    question: "I have a 9,000 dollar supply buy, what are my options?",
    context: {
      acquisitionType: "Supply",
      commerciality: "Not sure",
      valueBand: "At or near micro-purchase",
      competition: "Not sure",
      fundingLayer: "Air Force",
      urgency: "Normal"
    }
  },
  {
    id: "cyber",
    label: "DoD cyber clause",
    question: "Which FAR clauses are relevant for safeguarding covered contractor information systems?",
    context: {
      acquisitionType: "Service",
      commerciality: "Not sure",
      valueBand: "Above simplified acquisition threshold",
      competition: "Not sure",
      fundingLayer: "Air Force",
      urgency: "Normal"
    }
  },
  {
    id: "commercial-service-sat",
    label: "Commercial service",
    question: "Commercial service above the simplified acquisition threshold, which clauses should I inspect first?",
    context: {
      acquisitionType: "Service",
      commerciality: "Commercial",
      valueBand: "Above simplified acquisition threshold",
      competition: "Full and open",
      fundingLayer: "Air Force",
      urgency: "Normal"
    }
  },
  {
    id: "live-animals",
    label: "Live animal training",
    question: "Can an Air Force contract include training that uses live vertebrate animals, and what clause should I inspect?",
    context: {
      acquisitionType: "Service",
      commerciality: "Commercial",
      valueBand: "Above simplified acquisition threshold",
      competition: "Full and open",
      fundingLayer: "Air Force",
      urgency: "Normal"
    }
  },
  {
    id: "version-date",
    label: "Which version?",
    question: "Which version applies if a solicitation was issued before the FAR overhaul but award happens after the proposed rule?",
    context: {
      acquisitionType: "Service",
      commerciality: "Not sure",
      valueBand: "Above simplified acquisition threshold",
      competition: "Not sure",
      fundingLayer: "Air Force",
      urgency: "Normal"
    }
  }
];
