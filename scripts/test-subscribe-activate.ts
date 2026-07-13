import 'dotenv/config';
import { subscribeAndActivate } from '../src/lib/txline';

async function main() {
  const result = await subscribeAndActivate({
    serviceLevelId: 1,
    durationWeeks: 4,
    selectedLeagues: [],
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
