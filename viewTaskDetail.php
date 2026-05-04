<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Task Details</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet"
        integrity="sha384-EVSTQN3/azprG1Anm3QDgpJLIm9Nao0Yz1ztcQTwFspd3yD65VohhpuuCOmLASjC"
        crossorigin="anonymous">
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js"
        integrity="sha384-MrcW6ZMFYlzcLA8Nl+NtUVF0sA7MsXsP1UyJoMp4YLEuNSfAP+JcXn/tWtIaxVXM"
        crossorigin="anonymous"></script>
        <link rel="stylesheet" href="styles.css">

        <style>
        body {
            font-family: 'Arial', sans-serif;
            background-color: #f8f9fa;
        }

        .container {
            background-color: #ffffff;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
        }

        h2 {
            color: #ED1b24;
        }


        img {
            max-width: 100%;
            max-height: 200px;
        }
        </style>
</head>

<body>
    <div class="container my-5">
        <h2>Task Details</h2>
        <?php
        include "connection.php";

        if (isset($_GET["id"])) {
            $id = $_GET["id"];

            $sql = "SELECT * FROM truckloadinformationtable WHERE id = $id";
            $result = $con->query($sql);

            if (!$result) {
                die("Invalid query: " . $con->error);
            }

            if ($row = $result->fetch_assoc()) {
                echo "
                <table class='table'>
                    <tr>
                        <th>DR3 Site</th>
                        <td>$row[DR3Site]</td>
                    </tr>
                    <tr>
                        <th>Received From</th>
                        <td>$row[receivedFrom]</td>
                    </tr>
                    <tr>
                        <th>BOL</th>
                        <td>$row[BOL]</td>
                    </tr>
                    <tr>
                        <th>Forklift Driver</th>
                        <td>$row[forkliftDriver]</td>
                    </tr>
                    <tr>
                        <th>Load Date</th>
                        <td>$row[loadDate]</td>
                    </tr>
                    <tr>
                        <th>Stacks</th>
                        <td>$row[stacks]</td>
                    </tr>
                    <tr>
                        <th>Total Mattresses</th>
                        <td>$row[totalMattresses]</td>
                    </tr>
                    <tr>
                        <th>Image</th>
                        <td><img src='$row[image]' alt='Image' style='max-width: 500px; max-height: 500px;'></td>
                    </tr>
                    <tr>
                        <th>Status</th>
                        <td>$row[status]</td>
                    </tr>
                </table>";
            } else {
                echo "<p>No task found with the specified ID.</p>";
            }
        } else {
            echo "<p>No ID specified.</p>";
        }
        ?>

        <a href="viewTasks.php" class="cancelbtn">Back</a>
        <button onclick="window.print();" class="submitbtn" id="print-btn">Print</button>
      

        
        
                        
    </div>
</body>

</html>
