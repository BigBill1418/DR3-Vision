<?php
session_start();
include "connection.php";

if ($_SERVER['REQUEST_METHOD'] == 'POST' && isset($_POST['submit'])) {
    $id = isset($_POST['id']) ? $_POST['id'] : '';

    // Check if formId is set in the URL
    if ($_SERVER["REQUEST_METHOD"] == "POST") {
        $user_id = $_POST['id'];

        if (
            isset($_POST['concatenatedData']) &&
            isset($_POST['totalMattresses']) &&
            isset($_FILES['image'])
        ) {
            $stacks = mysqli_real_escape_string($con, $_POST['concatenatedData']);
            $totalMattresses = mysqli_real_escape_string($con, $_POST['totalMattresses']);
            
            $pic_uploaded = 0;

            $imageExtension = strtolower(pathinfo($_FILES["image"]["name"], PATHINFO_EXTENSION));
            $uniqueFilename = uniqid() . '.' . $imageExtension;
            $targetDirectory = $_SERVER['DOCUMENT_ROOT'] . '/webapp/images/';

            if (!file_exists($targetDirectory)) {
                mkdir($targetDirectory, 0755, true);
            }

            if (move_uploaded_file($_FILES['image']['tmp_name'], $targetDirectory . $uniqueFilename)) {
                if (!in_array($imageExtension, ['jpg', 'jpeg', 'png'])) {
                    echo "Error: Please upload a photo with the extension .jpg, .jpeg, or .png";
                } else if ($_FILES["image"]["size"] > 2000000) {
                    echo "Error: Your photo exceeds the size of 2MB";
                } else {
                    $pic_uploaded = 1;
                }
            } else {
                echo "Error: File upload failed. Check your directory permissions.";
            }
        }

        if ($pic_uploaded == 1) {
            $imagePathInDatabase = '/webapp/images/' . $uniqueFilename;

            $sql = "UPDATE `truckloadinformationtable` SET `stacks` = '$stacks', `totalMattresses` = '$totalMattresses', `image` = '$imagePathInDatabase' WHERE `id` = $id";
            
            $query = mysqli_query($con, $sql);
            if ($query) {
                $successMessage = "";
                $successMessage = "Task added correctly";
            } else {
                echo 'Error Occurred: ' . mysqli_error($con);
            }
        }
    } else {
        echo 'Error: formId is not set in the URL.';
    }

    mysqli_close($con);
}
?>
