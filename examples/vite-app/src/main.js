document.querySelector("#app").innerHTML = `<h1>Vite on Rynk</h1><p>Open this page on your phone with the Network URL.</p><button id="n">Clicked 0 times</button>`;
let n = 0;
document.querySelector("#n").addEventListener("click", (e) => (e.target.textContent = `Clicked ${++n} times`));
