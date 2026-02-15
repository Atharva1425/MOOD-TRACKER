// Recommendation logic
function recommendActivity(mood) {
    mood = mood.toLowerCase();
    if(mood === "happy") return "Solve challenging coding problems!";
    if(mood === "sad") return "Revise easy topics or watch a learning video.";
    if(mood === "tired") return "Take a 20-min nap or short walk.";
    if(mood === "stressed") return "Do meditation or light revision.";
    return "Read notes or organize study material.";
}

// Save mood to localStorage
function saveMood() {
    const moodSelect = document.getElementById("mood");
    const mood = moodSelect.value;
    const recommendation = recommendActivity(mood);

    // Display recommendation
    document.getElementById("recommendation").innerText = recommendation;

    // Save to localStorage
    let history = JSON.parse(localStorage.getItem("moodHistory") || "[]");
    history.push({mood: mood, time: new Date().toLocaleString()});
    localStorage.setItem("moodHistory", JSON.stringify(history));

    // Update history display
    displayHistory();
}

// Display mood history
function displayHistory() {
    const historyDiv = document.getElementById("history");
    let history = JSON.parse(localStorage.getItem("moodHistory") || "[]");

    if(history.length === 0){
        historyDiv.innerHTML = "<p>No history yet</p>";
        return;
    }

    let html = "<ul>";
    history.forEach(entry => {
        html += `<li>${entry.time} - ${entry.mood}</li>`;
    });
    html += "</ul>";
    historyDiv.innerHTML = html;
}

// Initialize history on page load
window.onload = displayHistory;
