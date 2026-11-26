// Prints a bcrypt hash for ADMIN_PASSWORD_HASH. The password is read with input
// hidden, so it never appears on screen or in shell history.
//   npm run admin:hash-password
import readline from "node:readline";
import bcrypt from "bcryptjs";

const COST = 12;
const MIN_LENGTH = 12;

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

if (!process.stdin.isTTY) {
  console.error("Run this in an interactive terminal so the password stays hidden.");
  process.exit(1);
}
const password = await ask("New admin password: ");
if (password.length < MIN_LENGTH) {
  console.error(`Use at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}
if (password !== await ask("Repeat it: ")) {
  console.error("The two entries did not match.");
  process.exit(1);
}
const hash = await bcrypt.hash(password, COST);
console.log("\nSet this as ADMIN_PASSWORD_HASH (Railway Variables), then remove ADMIN_PASSWORD:\n");
console.log(hash);
