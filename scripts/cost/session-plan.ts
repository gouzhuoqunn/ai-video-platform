import { formatSessionCostPlan } from "./session-cost";

function main() {
  console.log(JSON.stringify(formatSessionCostPlan(), null, 2));
}

void main();
