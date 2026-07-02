import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";
import { joinOptions } from "./joinOptions";

function startGame() {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    width: 960,
    height: 640,
    backgroundColor: "#1b1b22",
    physics: {
      default: "arcade",
      arcade: {
        gravity: { x: 0, y: 0 },
        debug: false,
      },
    },
    scene: [GameScene],
  });
}

const overlay = document.getElementById("join-overlay")!;
const form = document.getElementById("join-form") as HTMLFormElement;
const nameInput = document.getElementById("join-name") as HTMLInputElement;
const classSelect = document.getElementById("join-class") as HTMLSelectElement;
const dungeonSelect = document.getElementById("join-dungeon") as HTMLSelectElement;
const swatches = Array.from(document.querySelectorAll<HTMLDivElement>(".swatch"));

let selectedColor = "0x4da6ff";
swatches.forEach((swatch) => {
  swatch.addEventListener("click", () => {
    swatches.forEach((s) => s.classList.remove("selected"));
    swatch.classList.add("selected");
    selectedColor = swatch.dataset.color ?? selectedColor;
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  joinOptions.name = nameInput.value.trim() || "Player";
  joinOptions.color = selectedColor;
  joinOptions.className = classSelect.value;
  joinOptions.dungeonId = dungeonSelect.value;
  overlay.remove();
  startGame();
});
