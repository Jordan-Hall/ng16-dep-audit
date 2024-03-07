#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const semver = require("semver");

const args = process.argv.slice(2);
const helpArg = args.find(arg => arg === '-h' || arg === '--help');
const versionArg = args.find(arg => arg === '-v' || arg === '--version');
const outputArg = args.find(arg => arg.startsWith('--output='));
const outputFile = outputArg ? outputArg.split('=')[1] : null;
const styleArg = args.find(arg => arg.startsWith('--style='));
const style = styleArg ? styleArg.split('=')[1] : 'line';

if (helpArg) {
	displayHelp();
	process.exit();
}

if (versionArg) {
	displayVersion();
	process.exit();
}


function displayVersion() {
	console.log('1.2.0');
}

function displayHelp() {
	console.log(colorize('ng16-dep-audit', 'cyan', 'bold') + colorize(' - ', 'reset') + colorize('Audit your dependencies to see if you can upgrade to Angular 16. You can only do that if your dependencies support ivy engine. Since ngcc removal in Angular 16, view engine dependencies are no longer supported.', 'cyan', 'italic'));
	console.log('\n'); // Adding a newline for better spacing

	console.log(colorize('Usage:', 'yellow', 'bold'));
	console.log(colorize('  npx ng16-dep-audit [options]', 'reset') + '\n');

	console.log(colorize('Options:', 'yellow', 'bold'));
	console.log(colorize('  -h, --help', 'green') + colorize('            Output usage information', 'reset'));
	console.log(colorize('  -v, --version', 'green') + colorize('         Output the version number', 'reset'));
	console.log(colorize('  --output=<file>', 'green') + colorize('       Specify the output file', 'reset'));
	console.log(colorize('  --style=<style>', 'green') + colorize('       Specify the output style (line, table, markdown)', 'reset') + '\n');


	console.log(colorize('Examples:', 'yellow', 'bold'));
	console.log(colorize('  npx ng16-dep-audit --style=table', 'cyan'));
	console.log(colorize('  npx ng16-dep-audit --output=output.md --style=markdown', 'cyan'));
}


function colorize(text, color, style = '') {
  const colors = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: '\x1b[36m',
    reset: "\x1b[0m",
  };
  const styles = {
		bold: '\x1b[1m',
		italic: '\x1b[3m',
	};
	return `${styles[style] || ''}${colors[color] || ''}${text}${colors.reset}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpGetWithRetry(url, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        https
          .get(url, (resp) => {
            let data = "";
            if (resp.statusCode === 404) {
              resolve(null); // Ignore 404 errors and resolve as null
              return;
            } else if (
              resp.statusCode === 429 ||
              resp.statusCode < 200 ||
              resp.statusCode > 299
            ) {
              let error =
                resp.statusCode === 429
                  ? "Rate limit exceeded"
                  : `HTTP status code ${resp.statusCode}`;
              if (attempt < retries) {
                reject(error);
              } else {
                // Last attempt, but we ignore 404, so only reject if it's not 404.
                reject(error);
              }
            } else {
              resp.on("data", (chunk) => {
                data += chunk;
              });
              resp.on("end", () => {
                resolve(JSON.parse(data));
              });
            }
          })
          .on("error", (err) => {
            reject("Error: " + err.message);
          });
      });
    } catch (error) {
      if (attempt < retries) {
        console.log(
          `Attempt ${attempt} failed for ${url}. Error: ${error}. Retrying in ${delayMs}ms...`,
        );
        await delay(delayMs * Math.pow(2, attempt - 1)); // Exponential backoff
      } else if (error !== "HTTP status code 404") {
        // Log error after all retries (except for 404s)
        console.error(`Failed to fetch ${url} after ${retries} attempts.`);
      }
    }
  }
}

function updateProgressBar(processedPackages, totalPackages) {
  process.stdout.write("\x1B[2J\x1B[0f");
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(
    `Processing: [${"#".repeat(processedPackages)}${".".repeat(totalPackages - processedPackages)}]`,
  );
}

async function checkAngularCompatibility(
  packageName,
  dependenciesToCheck,
  totalPackages,
  currentVersion,
) {
  const prefixesToUpgrade = ["@swimlane/ngx"]; // Extendable list of package name prefixes

  // Check if the packageName starts with any of the prefixes in prefixesToUpgrade
  const shouldUpgrade = prefixesToUpgrade.some((prefix) =>
    packageName.startsWith(prefix),
  );
  if (shouldUpgrade) {
    dependenciesToCheck.mayNeedUpgrade.push({
      packageName,
      currentVersion,
      latestVersion: "unknown",
    });
    return;
  }

  const url = `https://registry.npmjs.org/${packageName}/latest`;
  try {
    const packageInfo = await httpGetWithRetry(url);
    const latestVersion = packageInfo.version;
    console.log(colorize(`${packageName}:`, "yellow"));
    console.log(colorize(`Current version: ${currentVersion}`, "green"));
    console.log(colorize(`Latest version: ${latestVersion}`, "blue"));

    const allDependencies = {
      ...packageInfo.dependencies,
      ...packageInfo.devDependencies,
      ...packageInfo.peerDependencies,
    };
    const hasAngularCoreDependency = "@angular/core" in allDependencies;

    if (hasAngularCoreDependency) {
      const angularCoreVersion = allDependencies["@angular/core"];
      if (
        angularCoreVersion &&
        semver.lte(semver.minVersion(angularCoreVersion), "12.0.0")
      ) {
        dependenciesToCheck.reviewForRemoval.push({
          packageName,
          currentVersion,
          latestVersion,
        });
      } else {
        dependenciesToCheck.mayNeedUpgrade.push({
          packageName,
          currentVersion,
          latestVersion,
        });
      }
    } else {
      dependenciesToCheck.unknown.push(packageName);
    }
  } catch (error) {
    console.error(
      colorize(`Could not fetch data for package: ${packageName}`, "red"),
      error,
    );
  }
}

async function getDependenciesAndCheckCompatibility() {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.error(
      colorize("No package.json found in the current directory", "red"),
    );
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = packageJson.dependencies || {};
  const totalPackages = Object.keys(dependencies).length;

  let dependenciesToCheck = {
    mayNeedUpgrade: [],
    reviewForRemoval: [],
    unknown: [],
    processedPackages: 0,
  };

  updateProgressBar(dependenciesToCheck.processedPackages, totalPackages);

  const promises = Object.keys(dependencies).map((packageName) =>
    checkAngularCompatibility(
      packageName,
      dependenciesToCheck,
      totalPackages,
      dependencies[packageName],
    )
      .then(() => {
        dependenciesToCheck.processedPackages++;
        if (
          dependenciesToCheck.processedPackages % 5 === 0 ||
          dependenciesToCheck.processedPackages === totalPackages
        ) {
          updateProgressBar(
            dependenciesToCheck.processedPackages,
            totalPackages,
          );
        }
      })
      .catch((error) =>
        console.error(
          colorize(`Could not fetch data for package: ${packageName}`, "red"),
          error,
        ),
      ),
  );

  await Promise.all(promises);

  updateProgressBar(dependenciesToCheck.processedPackages, totalPackages);
  console.log("\n\n");

  if (outputFile) {
		fs.writeFileSync(outputFile, '', { encoding: 'utf8' });
	} else {
		console.log('\x1B[2J\x1B[0f');
	}

	// Depending on the style, print the output
	switch (style) {
		case 'line':
			printLineOutput(dependenciesToCheck);
			break;
		case 'table':
			printTableOutput(dependenciesToCheck);
			break;
		case 'markdown':
			printMarkdownOutput(dependenciesToCheck);
			break;
		default:
			writeToOutput('Unsupported style');
			break;
	}
}

function calculateColumnWidths(rows) {
	let maxWidths = { packageName: 'Package'.length, currentVersion: 'Current Version'.length, latestVersion: 'Latest Version'.length };
	rows.forEach(row => {
		maxWidths.packageName = Math.max(maxWidths.packageName, row.packageName.length);
		maxWidths.currentVersion = Math.max(maxWidths.currentVersion, row.currentVersion.length);
		maxWidths.latestVersion = Math.max(maxWidths.latestVersion, row.latestVersion.length);
	});
	return maxWidths;
}

function printTable(header, rows, headerColor) {
	const widths = calculateColumnWidths(rows);
	const headerLine = colorize(`| ${'Package'.padEnd(widths.packageName)} | ${'Current Version'.padEnd(widths.currentVersion)} | ${'Latest Version'.padEnd(widths.latestVersion)} |`, headerColor);

	writeToOutput(colorize(header, headerColor));
	writeToOutput(colorize('-'.repeat(headerLine.length), headerColor));
	writeToOutput(headerLine);
	writeToOutput(colorize('-'.repeat(headerLine.length), headerColor));

	rows.forEach(({ packageName, currentVersion, latestVersion }) => {
		writeToOutput(`| ${colorize(packageName.padEnd(widths.packageName), headerColor, 'bold')} | ${colorize(currentVersion.padEnd(widths.currentVersion), 'yellow', 'italic')} | ${colorize(latestVersion.padEnd(widths.latestVersion), 'blue', 'italic')} |`);
	});

	console.log(colorize('-'.repeat(headerLine.length), headerColor));
	console.log();
}

function writeToOutput(content) {
	if (outputFile) {
		fs.appendFileSync(outputFile, content + '\n', { encoding: 'utf8' });
	} else {
		console.log(content);
	}
}

function printLineOutput(dependenciesToCheck) {
	writeToOutput(colorize('\nDependencies without @angular/core or dependencies visible in NPM registry:', 'yellow'));
	dependenciesToCheck.unknown.forEach(dep => writeToOutput(colorize(`- ${dep}`, 'yellow')));

	writeToOutput('\n\n');

	writeToOutput(colorize('Dependencies that are maintained but may need upgrading:', 'green'));
	dependenciesToCheck.mayNeedUpgrade.forEach(({ packageName, currentVersion, latestVersion }) => {
		writeToOutput(`- ${colorize(packageName, 'green', 'bold')}\n (current: ${colorize(currentVersion, 'yellow', 'italic')}, latest: ${colorize(latestVersion, 'blue', 'italic')})\n`);
	});

	writeToOutput(colorize('\nDependencies to review for removal or replacement:', 'red'));
	dependenciesToCheck.reviewForRemoval.forEach(({ packageName, currentVersion, latestVersion }) => {
		writeToOutput(`- ${colorize(packageName, 'red', 'bold')}\n (current: ${colorize(currentVersion, 'yellow', 'italic')}, latest: ${colorize(latestVersion, 'blue', 'italic')})\n`);
	});
}

function printTableOutput(dependenciesToCheck) {
	if (dependenciesToCheck.unknown.length > 0) {
		console.log(colorize('\nDependencies without @angular/core or dependencies visible in NPM registry:', 'yellow'));
		dependenciesToCheck.unknown.forEach(dep => console.log(colorize(`- ${dep}`, 'yellow')));
		console.log('\n\n');
	}

	if (dependenciesToCheck.mayNeedUpgrade.length > 0) {
		printTable('Dependencies that are maintained but may need upgrading:', dependenciesToCheck.mayNeedUpgrade, 'green');
		console.log('\n');
	}

	if (dependenciesToCheck.reviewForRemoval.length > 0) {
		printTable('Dependencies to review for removal or replacement:', dependenciesToCheck.reviewForRemoval, 'red');
	}
}

function printMarkdownOutput(dependenciesToCheck) {
	if (dependenciesToCheck.mayNeedUpgrade.length > 0) {
		writeToOutput(`### Dependencies that are maintained but may need upgrading`);
		writeToOutput(`| Package | Current Version | Latest Version |`);
		writeToOutput(`| ------- | --------------- | -------------- |`);
		dependenciesToCheck.mayNeedUpgrade.forEach(dep => {
			writeToOutput(`| ${dep.packageName} | ${dep.currentVersion} | ${dep.latestVersion} |`);
		});
		writeToOutput('\n');
	}

	if (dependenciesToCheck.reviewForRemoval.length > 0) {
		writeToOutput(`### Dependencies to review for removal or replacement`);
		writeToOutput(`| Package | Current Version | Latest Version |`);
		writeToOutput(`| ------- | --------------- | -------------- |`);
		dependenciesToCheck.reviewForRemoval.forEach(dep => {
			writeToOutput(`| ${dep.packageName} | ${dep.currentVersion} | ${dep.latestVersion} |`);
		});
		writeToOutput('\n');
	}

	if (dependenciesToCheck.unknown.length > 0) {
		writeToOutput(`### Dependencies without @angular/core or dependencies visible in NPM registry`);
		dependenciesToCheck.unknown.forEach(dep => {
			writeToOutput(`- ${dep}`);
		});
		writeToOutput('\n');
	}
}

getDependenciesAndCheckCompatibility();
