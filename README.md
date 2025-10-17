# Web Scaler & Display Proxy

A powerful, self-hosted web proxy designed to display, scale, and auto-scroll any webpage. Ideal for digital signage, dashboards, and custom presentations on displays like the Unifi DisplayCast.

This application is built with Node.js and packaged in a Docker container for easy, cross-platform deployment. It provides a simple web interface to configure the target URL, zoom level, and advanced auto-scrolling sequences on the fly.

*Caption: The configuration UI allows for easy, real-time adjustments.*

## Features

* **URL Display**: Show any public webpage through the proxy.
* **Custom Scaling**: Zoom in or out of any webpage to make it fit your display perfectly.
* **Advanced Auto-Scrolling**:
    * Enable or disable auto-scrolling with a single click.
    * Control the scroll speed in pixels per second.
    * Define custom scroll sequences (e.g., `0-500, 1200-1800`) to focus on specific content sections.
* **Live Page Height Reporting**: Automatically detects and displays the total pixel height of the target page to help you configure scroll sequences.
* **Live Reload**: The main display page automatically reloads when you save a new configuration.
* **Persistent Configuration**: Settings are saved to a Docker volume and persist even if the container is restarted or recreated.
* **Easy Deployment**: A simple `run.sh` script handles resetting, building, and deploying the Docker container.
* **High Compatibility**: Fixes common proxying issues by handling CORS, cookies, redirects, and security headers.

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes.

### Prerequisites

You need to have Docker installed on your system.

* [Install Docker Engine](https://docs.docker.com/engine/install/)

### Installation & Deployment

1.  **Clone the Repository**
    ```
    git clone [https://github.com/leraptor65/web-scaler-proxy.git](https://github.com/leraptor65/web-scaler-proxy.git)
    cd web-scaler-proxy
    ```

2.  **Make the Deployment Script Executable**
    This only needs to be done once.
    ```
    chmod +x run.sh
    ```

3.  **Run the Deployment Script**
    The script will handle everything: stopping old containers, removing old images, building the new image, and starting the new container.
    ```
    ./run.sh
    ```
    *Note: The script uses `sudo` for Docker commands. If you run Docker without `sudo`, you can edit the script to remove it.*

4.  **Access the Application**
    * **View the Proxied Page**: Open your browser and navigate to `http://<your-server-ip>:1337`
    * **Configure the Proxy**: Open a new tab and go to `http://<your-server-ip>:1337/config`

## How to Configure

1.  Navigate to the `/config` page.
2.  **Target URL**: Enter the full URL of the website you want to display (e.g., `https://www.mortgagenewsdaily.com/mbs`).
3.  **Scale Factor**: Set the zoom level. `1.0` is 100%, `1.5` is 150%, and `0.8` is 80%.
4.  **Auto Scroll**: Check this box to enable the auto-scrolling feature.
5.  **Scroll Speed**: Set how fast the page scrolls in pixels per second.
6.  **Scroll Sequence**: (Optional) Define specific parts of the page to scroll.
    * Leave blank to scroll the entire page from top to bottom.
    * Enter ranges like `0-1000` to scroll from the top to 1000 pixels down.
    * Combine ranges with a comma: `0-1000, 2500-3500` will scroll the first section, wait, then jump to and scroll the second section before looping.
7.  Click **"Save Configuration"**. The main display page will automatically reload with the new settings.

## Built With

* [Node.js](https://nodejs.org/) - JavaScript runtime environment
* [Express.js](https://expressjs.com/) - Web framework for Node.js
* [Axios](https://axios-http.com/) - Promise-based HTTP client
* [Docker](https://www.docker.com/) - Containerization platform

## Author

* **leraptor65** - *Initial Work* - [leraptor65](https://github.com/leraptor65)

## License

This project is licensed under the MIT License - see the `LICENSE.md` file for details.
