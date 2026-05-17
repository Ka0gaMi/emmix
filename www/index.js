import init, { greet, hello_world } from "../pkg/emmix.js";

const message = document.querySelector("#message");
const printButton = document.querySelector("#print-button");

async function main() {
  await init();

  const textFromRust = hello_world();
  console.log(textFromRust);
  message.textContent = textFromRust;

  printButton.addEventListener("click", () => {
    greet();
    message.textContent = hello_world();
  });
}

main().catch((error) => {
  console.error("Failed to load the Rust WebAssembly module:", error);
  message.textContent = "WebAssembly failed to load. Check the console.";
});
