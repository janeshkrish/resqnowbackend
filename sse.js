
let clients = [];

export function addClient(res) {
    clients.push(res);
    console.log(`[SSE] Client connected. Total: ${clients.length}`);

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 15000);

    res.on('close', () => {
        clearInterval(heartbeat);
        clients = clients.filter(client => client !== res);
        console.log(`[SSE] Client disconnected. Total: ${clients.length}`);
    });
}
