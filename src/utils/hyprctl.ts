import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { readFile as readFileSync } from 'fs/promises';

const execAsync = promisify(exec);

interface Window {
    address: string;
    workspace: {
        id: number;
        name: string;
    };
    at: [number, number];
    size: [number, number];
    class: string;
    title: string;
    floating: boolean;
    pid: number;
    cmdline: string;
}

interface SessionData {
    windows: Window[];
}

// Execute hyprctl command and return the output
async function executeHyprctl(command: string): Promise<string> {
    try {
        const { stdout } = await execAsync(`hyprctl ${command}`);
        return stdout;
    } catch (error) {
        throw new Error(`Failed to execute hyprctl command: ${error}`);
    }
}

// Get current session state including window positions and workspaces
export async function getCurrentSession(): Promise<SessionData> {
    try {
        const clientsJson = await executeHyprctl('clients -j');

        // Add debug logging
        // console.log('Raw hyprctl output:', clientsJson);

        // Check if the output is empty or invalid
        if (!clientsJson.trim()) {
            console.log('No windows detected - returning empty array');
            return { windows: [] };
        }

        const windows = JSON.parse(clientsJson);

        // Validate that windows is an array
        if (!Array.isArray(windows)) {
            console.log('Unexpected data structure:', windows);
            return { windows: [] };
        }

        // Add command line information for each window
        for (const window of windows) {
            try {
                const pid = window.pid; // Assuming the window object has a pid property
                const cmdlinePath = `/proc/${pid}/cmdline`;
                const cmdline = await readFileSync(cmdlinePath, 'utf-8');
                window.cmdline = cmdline.replace(/\0/g, ' '); // Replace null characters with spaces
            } catch (error) {
                console.error(`Failed to read cmdline for window with PID ${window.pid}:`, error);
                window.cmdline = '';
            }
        }

        // console.log('Parsed windows with cmdline:', windows);
        return { windows };
    } catch (error) {
        console.error('Error in getCurrentSession:', error);
        throw new Error(`Failed to get current session: ${error}`);
    }
}

// Helper function to map window classes to launch commands
function getApplicationCommand(windowClass: string): string {
    // Special cases where the window class doesn't match the executable name
    const specialCases: Record<string, string> = {
        'google-chrome': 'google-chrome-stable',
        'gnome-terminal': 'gnome-terminal-server',
        'cursor-url-handler': 'cursor',
        // #TODO: user configurable cases, hsm defaults
    };

    const cleanClassName = windowClass.toLowerCase().trim();
    const command = specialCases[cleanClassName] || cleanClassName;
    return `/usr/bin/env ${command}`;
}


// Restore a saved session

export async function restoreSession(sessionData: SessionData): Promise<void> {
	try {
		console.log("Starting session restore with data:", sessionData);

		if (!sessionData?.windows?.length) {
			console.log("No windows to restore - session data is empty");
			return;
		}

		// 1) Get the currently active window (the terminal running this command),
		//    so we don't close it below
		const activeWindow = await executeHyprctl("activewindow -j").then(JSON.parse);

		// 2) Close all other windows to start fresh
		const initialSession = await getCurrentSession();
		for (const w of initialSession.windows) {
			if (w.address !== activeWindow.address) {
				await executeHyprctl(`dispatch closewindow address:${w.address}`);
			}
		}

		// 3) Group saved windows by class
		const windowsByClass = sessionData.windows.reduce<Record<string, Window[]>>((acc, window) => {
			if (!acc[window.class]) {
				acc[window.class] = [];
			}
			acc[window.class].push(window);
			return acc;
		}, {});

		// 4) Launch applications according to the number of saved windows
		//    If class "firefox" had 3 windows saved, we dispatch exec firefox 3 times.
		for (const window of sessionData.windows) {
			if (window.cmdline) {
				console.log(`Executing command line for window: ${window.cmdline}`);
				await execAsync(window.cmdline);
			} else {
				console.warn(`No command line found for window with address: ${window.address}`);
			}
		}
		// 5) Wait a few seconds for Hyprland to register the newly spawned windows
		console.log("Waiting 3 seconds for apps to launch and register...");
		await new Promise((resolve) => setTimeout(resolve, 3000));

		// 6) Get the current windows after launch
		const currentSession = await getCurrentSession();

		// 7) Group newly launched windows by class
		const currentWindowsByClass = currentSession.windows.reduce<Record<string, Window[]>>((acc, win) => {
			if (!acc[win.class]) {
				acc[win.class] = [];
			}
			acc[win.class].push(win);
			return acc;
		}, {});

		// 8) Build a batch of commands that:
		//    - Moves each window to the correct workspace
		//    - Toggles floating (if needed)
		//    - Moves the window to the saved position
		//    - Resizes the window to the saved size
		//
		//    We'll do it in one big batch to minimize flicker. We also
		//    can embed a "focuswindow" command if we like, but typically
		//    "focuswindow" is used individually.
		const positionCommands = Object.entries(windowsByClass)
			.flatMap(([windowClass, savedWindows]) => {
				const currentWindows = currentWindowsByClass[windowClass] || [];

				// Pair up each savedWindow with a currentWindow by index
				return savedWindows
					.map((savedWindow, index) => {
						const currentWindow = currentWindows[index];
						if (!currentWindow) return [];

						const commands: string[] = [];

						// Move to workspace if specified
						if (savedWindow.workspace?.id !== undefined) {
							// comma-syntax: movetoworkspace <id>,address:<window-address>
							commands.push(`dispatch movetoworkspace ${savedWindow.workspace.id},address:${currentWindow.address}`);
						}

						// If saved as floating, we can toggle it. Notice we append ,address:<addr>
						// so we can do it in batch. If you prefer separate calls, you can do so.
						if (savedWindow.floating) {
							commands.push(`dispatch togglefloating,address:${currentWindow.address}`);
						}

						// Move & resize the window to exact coordinates
						// Using "movewindowpixel exact" and "resizewindowpixel" from the older snippet
						commands.push(`dispatch movewindowpixel exact ${savedWindow.at[0]} ${savedWindow.at[1]},address:${currentWindow.address}`);
						commands.push(`dispatch resizewindowpixel ${savedWindow.size[0]} ${savedWindow.size[1]},address:${currentWindow.address}`);

						return commands;
					})
					.flat(); // flatten array of arrays
			})
			.join(" ; ");

		if (positionCommands) {
			console.log("Positioning and resizing windows...");
			await executeHyprctl(`--batch "${positionCommands}"`);
		}

		console.log("Session restoration complete.");
	} catch (error) {
		console.error("Detailed restore error:", error);
		throw new Error(`Failed to restore session: ${error}`);
	}
}


// Generate Hyprland rules for the session
function generateSessionRules(sessionData: SessionData): string {
    let rules = '# Generated by Hyprland Session Manager\n\n';

    sessionData.windows.forEach((window, index) => {
        rules += `windowrule = move ${window.at[0]} ${window.at[1]},^${window.class}$\n`;
        rules += `windowrule = size ${window.size[0]} ${window.size[1]},^${window.class}$\n`;
        rules += `windowrule = workspace ${window.workspace.name},^${window.class}$\n\n`;
    });

    return rules;
}

// Ensure the session config is sourced in Hyprland config
async function ensureSourceInHyprlandConfig(): Promise<void> {
    const configPath = join(homedir(), '.config', 'hypr', 'hyprland.conf');
    const sourceLine = 'source = ~/.local/share/hyprland-session-manager/sessions/active.conf';

    try {
        const config = await readFile(configPath, 'utf-8');
        if (!config.includes(sourceLine)) {
            await writeFile(configPath, `${config}\n${sourceLine}\n`);
        }
    } catch (error) {
        throw new Error(`Failed to update Hyprland config: ${error}`);
    }
}

