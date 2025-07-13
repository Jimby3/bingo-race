/* =====================================================================
   Client-side logic
   ===================================================================== */
const socket = io();

/* Cached room-wide state */
let currentRoom   = null;   // room ID we’re in
let boardSize     = 5;      // square dimension (updated on join / create)
let timerInterval = null;   // setInterval handle for stopwatch
let startTimeMs   = null;   // UTC ms when host pressed “Start”

/* ───────── DOM shortcuts ───────── */
const joinForm      = document.getElementById('joinForm');
const gameContainer = document.getElementById('gameContainer');
const boardEl       = document.getElementById('board');
const playersList   = document.getElementById('playersList');
const roomLabel     = document.getElementById('roomLabel');
const startBtn      = document.getElementById('startBtn');
const timerLabel    = document.getElementById('timer');

const messages      = document.getElementById('messages');
const messageInput  = document.getElementById('messageInput');
const sendBtn       = document.getElementById('sendBtn');

const scores        = document.getElementById('scores');
const createOptions = document.getElementById('createOptions');
const boardDataTa   = document.getElementById('boardData');
const boardSizeInp  = document.getElementById('boardSize');

/* =====================================================================
   JOIN / CREATE ROOM UI
   ===================================================================== */

/* Create */
document.getElementById('createBtn').addEventListener('click', () => {
    if (createOptions.style.display === 'none') {
        // Show create options menu
        createOptions.style.display = 'block';
        document.getElementById('joinBtn').style.display = 'none';
        document.getElementById('createBtn').textContent = 'Create Room';
    } else {
        // Create room logic
        const username = document.getElementById('username').value.trim();
        const roomId = document.getElementById('roomId').value.trim();
        const size = parseInt(boardSizeInp.value, 10);

        if (!username || !roomId) return alert('Enter username and room ID');
        if (size < 2) return alert('Size must be at least 2');

        try {
            const goalList = JSON.parse(boardDataTa.value.trim());
            validateGoalList(goalList);
            const simpleGoalList = goalList.map(item => item.name);

            if (simpleGoalList.length < size * size) {
                throw new Error(`Need at least ${size * size} goals for a ${size}x${size} board`);
            }

            socket.emit('create-room', { roomId, username, size, goalList: simpleGoalList });
        } catch (err) {
            alert(`Invalid goal list: ${err.message}`);
        }
    }
});

/* Join */
document.getElementById('joinBtn').addEventListener('click', () => {
    const username = document.getElementById('username').value.trim();
    const roomId   = document.getElementById('roomId').value.trim();
    if (!username || !roomId) return alert('Enter username and room ID');

    socket.emit('join-room', { roomId, username });
});

/* =====================================================================
   IN-GAME CONTROLS
   ===================================================================== */
startBtn.addEventListener('click', () => {
    socket.emit('start-game', { roomId: currentRoom });
    startBtn.disabled  = true;
    startBtn.textContent = 'Game in Progress…';
});

sendBtn.addEventListener('click', sendChat);
messageInput.addEventListener('keypress', e => e.key === 'Enter' && sendChat());

function sendChat(){
    const text = messageInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', { roomId: currentRoom, message: text });
    messageInput.value = '';
}

/* =====================================================================
   BOARD + PLAYER LIST RENDERING
   ===================================================================== */
function createBoard(boardData,size){
    boardSize = size;
    boardEl.style.gridTemplateColumns = `repeat(${size},1fr)`;
    boardEl.innerHTML = '';

    boardData.forEach( (row,i) => row.forEach( (cell,j) => {
        const div = document.createElement('div');
        div.className   = 'cell';
        div.textContent = cell.value;

        if (cell.state==='X'){
            div.classList.add('marked');
            div.style.backgroundColor = cell.color || '#000';
        }

        /* Only the owner (or unclaimed) may toggle */
        div.addEventListener('click', () => {
            if (!cell.ownerId || cell.ownerId === socket.id){
                socket.emit('update-cell', { roomId: currentRoom, row:i, col:j });
            }
        });

        boardEl.appendChild(div);
    }));
}

function updatePlayers(players){
    playersList.innerHTML = '';
    scores.innerHTML      = '';

    players.forEach(p=>{
        /* colour tag in header */
        const tag = document.createElement('div');
        tag.className            = 'player-tag';
        tag.style.backgroundColor = p.color;
        tag.textContent          = p.username + (p.isCreator?' (Creator)':'');
        playersList.appendChild(tag);

        /* scoreboard line */
        const line = document.createElement('div');
        line.style.color = p.color;
        line.textContent = `${p.username}: ${p.score}`;
        scores.appendChild(line);
    });
}

/* =====================================================================
   STOPWATCH
   ===================================================================== */
function startTimer(startUtcMs){
    clearInterval(timerInterval);
    startTimeMs = startUtcMs;

    const pad = n => n<10?'0'+n:n;

    function tick(){
        const elapsed = Date.now() - startTimeMs;
        const mins = Math.floor(elapsed/60000);
        const secs = Math.floor((elapsed%60000)/1000);
        timerLabel.textContent = `${pad(mins)}:${pad(secs)}`;
    }
    tick();
    timerInterval = setInterval(tick,1000);
}

/* =====================================================================
   SOCKET.IO EVENTS
   ===================================================================== */
socket.on('room-error', msg => alert(msg));

socket.on('room-created', ({ roomId, board, size, players })=>{
    enterRoom(roomId,true);
    createBoard(board,size);
    updatePlayers(players);
});

socket.on('init', (payload) => {
    const { board, size, players, gameStarted, roomId } = payload;
    enterRoom(roomId, false);
    createBoard(board, size);
    updatePlayers(players);
    if (gameStarted) {
        boardEl.style.display = 'grid';
        startBtn.style.display = 'none';
    } else {
        boardEl.style.display = 'none';
    }
});

socket.on('player-joined', updatePlayers);
socket.on('player-left',  updatePlayers);

socket.on('game-start', ({ board, size, startTime }) => {
    createBoard(board, size);
    boardEl.style.display = 'grid'; // Show board when game starts
    startBtn.style.display = 'none';
    startTimer(startTime);
});

socket.on('cell-updated', ({ row,col,state,color })=>{
    const idx  = row*boardSize + col;
    const cell = boardEl.children[idx];
    if (!cell) return;

    if (state==='X'){
        cell.classList.add('marked');
        cell.style.backgroundColor = color;
    }else{
        cell.classList.remove('marked');
        cell.style.backgroundColor = '';
    }
});

socket.on('scores-updated', ({ players }) => {
    updatePlayers(players);
});

socket.on('chat-message', ({ username,message,color })=>{
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:${color}">${username}:</span> ${message}`;
    messages.appendChild(line);
    messages.scrollTop = messages.scrollHeight;
});

/* =====================================================================
   HELPER: switch from join form to game screen
   ===================================================================== */
function enterRoom(roomId, isCreator) {
    currentRoom = roomId;
    joinForm.style.display = 'none';
    gameContainer.style.display = 'block';
    boardEl.style.display = 'none'; // Hide board initially

    roomLabel.textContent = `Room: ${roomId}` + (isCreator ? ' (Creator)' : '');
    startBtn.style.display = isCreator ? 'block' : 'none';
}

function validateGoalList(list) {
    if (!Array.isArray(list)) {
        throw new Error('Goal list must be an array');
    }

    if (!list.every(item =>
        item &&
        typeof item === 'object' &&
        typeof item.name === 'string' &&
        item.name.trim()
    )) {
        throw new Error('Each goal must be an object with a non-empty name property');
    }

    const names = list.map(item => item.name);
    const unique = new Set(names);
    if (unique.size !== names.length) {
        throw new Error('Goal names must be unique');
    }
    return true;
}

function formatGoalList(list) {
    if (Array.isArray(list)) {
        // If input is array of strings, convert to objects
        if (typeof list[0] === 'string') {
            return JSON.stringify(list.map(name => ({ name })), null, 2);
        }
        // If input is already in correct format, just stringify
        return JSON.stringify(list, null, 2);
    }
    throw new Error('Invalid goal list format');
}

// Example default goals in the new format
const defaultGoals = [
    { name: "Go through a Portal" },
    { name: "Find an egg" },
    { name: "Win the game" },
    { name: "Kill a zombie" },
    { name: "Get an Upgrade" },
    { name: "Complete the Tutorial" },
    { name: "Craft something" },
    { name: "Level Up" },
    { name: "Get a pet" },
    { name: "Score a goal" },
    { name: "Defeat a Boss" },
    { name: "Build a house" },
    { name: "Cast a Spell" },
    { name: "Drink a Potion" },
    { name: "Find a Frog" },
    { name: "Do a Backflip" },
    { name: "Build A Turret" },
    { name: "Play an Instrument" },
    { name: "Steal some Treasure" },
    { name: "See a Ghost" },
    { name: "Use a Shovel" },
    { name: "Build a Campfire" },
    { name: "Sleep through the night" },
    { name: "Ride a boat" },
    { name: "Open a Treasure chest" }
];

boardDataTa.value = formatGoalList(defaultGoals);
boardDataTa.placeholder = 'Enter goals as JSON array:\n[{"name": "Goal 1"}, {"name": "Goal 2"}]';